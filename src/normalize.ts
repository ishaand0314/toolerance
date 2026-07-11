/**
 * normalize — the provider-agnostic step that runs ONCE between parse and
 * serialize, so all six serializers see one canonical, ref-free schema instead
 * of each re-deriving refs/nullability independently and disagreeing.
 *
 * This is llm-attrition's `validate.ts` role, but it does much more:
 *   1. Validate the ToolDef envelope (missing name, non-object parameters).
 *   2. Inline `$ref` / `$defs` (and legacy `definitions`) into a self-contained
 *      tree, resolving JSON Pointers, so serializers can assume no refs.
 *   3. Detect `$ref` cycles during inlining. Recursion cannot be inlined
 *      (infinite), so it is recorded: the cyclic subgraph is left as a canonical
 *      `$ref` + `$defs` island and the cycling pointers are stashed on
 *      `extra["normalize.cycles"]`, so each serializer's policy can decide
 *      (keep the island / drop as a loss / depth-limit for gemini-vertex).
 *   4. Normalize nullability to the canonical union form `type: ["T","null"]`.
 *      Serializers convert to `nullable: true` where the dialect wants it.
 *   5. Canonicalize boolean schemas where a top-level object is required.
 *
 * Nothing here throws. Every irrecoverable situation (an unresolvable `$ref`, a
 * recursion) becomes a note, never an exception — the honest record is the point.
 */

import type { NoteCollector } from "./notes.js";
import {
  type JSONSchema,
  type ObjectSchema,
  type ToolDef,
  asArray,
  asRecord,
  asSchema,
  cloneSchema,
  isObjectSchema,
} from "./schema.js";

export interface NormalizeOptions {
  /** Max nesting depth before inlining bails and records a recursion note. */
  readonly maxInlineDepth?: number;
}

/** The keyword positions that hold a subschema (single schema). */
const SUBSCHEMA_KEYS = [
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
] as const;

/** Keyword positions that hold a record of name -> subschema. */
const SUBSCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"] as const;

/** Keyword positions that hold an array of subschemas. */
const SUBSCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/**
 * Normalize a parsed ToolDef in place-ish (returns a fresh canonical ToolDef).
 * Accumulates notes on `notes`, which land between the parser's notes and the
 * serializer's notes in the final report.
 */
export function normalize(
  tool: ToolDef,
  notes: NoteCollector,
  options: NormalizeOptions = {},
): ToolDef {
  const maxDepth = options.maxInlineDepth ?? 64;

  // 1. Envelope validation.
  if (tool.name.trim().length === 0) {
    notes.warning("Tool has no name; left empty (never invented)", "name");
  }

  let parameters: JSONSchema = tool.parameters;
  if (typeof parameters === "boolean") {
    // A boolean `parameters` (true/false schema) has no object shape. Every
    // dialect's tool `parameters` must be an object schema, so canonicalize.
    if (parameters === true) {
      notes.info("Normalized boolean `true` parameters to an empty object schema", "parameters");
    } else {
      notes.warning(
        "Normalized boolean `false` parameters (accepts nothing) to an empty object schema",
        "parameters",
      );
    }
    parameters = { type: "object" };
  } else if (!isObjectSchema(parameters)) {
    notes.info("Tool has no object parameters; defaulted to an empty object schema", "parameters");
    parameters = { type: "object" };
  }

  const root = cloneSchema(parameters) as ObjectSchema;

  // 2 + 3. Inline refs, detecting cycles.
  const defs = collectDefs(root, notes);
  const cyclic = new Set<string>();
  const inlined = inlineRefs(root, defs, notes, [], cyclic, maxDepth, "parameters");
  const canonicalParameters = isObjectSchema(inlined) ? stripDefs(inlined) : { type: "object" };

  // 3b. A tool's `parameters` root is an object by contract in every dialect.
  // If the root ended up with no `type` and no top-level combinator to define its
  // shape, default it to `type:"object"` so serializers emit a valid root.
  if (
    canonicalParameters.type === undefined &&
    canonicalParameters.$ref === undefined &&
    canonicalParameters.anyOf === undefined &&
    canonicalParameters.oneOf === undefined &&
    canonicalParameters.allOf === undefined
  ) {
    canonicalParameters.type = "object";
    notes.info(
      'Defaulted the parameters root to `type:"object"` (required by every dialect)',
      "parameters",
    );
  }

  // 4. Nullability -> canonical union form.
  normalizeNullability(canonicalParameters, notes, "parameters");

  const result: ToolDef = {
    name: tool.name,
    parameters: canonicalParameters,
  };
  if (tool.description !== undefined) result.description = tool.description;

  // Carry the parser's extra forward, and record cyclic pointers so serializers
  // can decide per dialect (keep the $ref island / loss / depth-limit).
  const extra: Record<string, unknown> = { ...(tool.extra ?? {}) };
  if (cyclic.size > 0) {
    extra["normalize.cycles"] = [...cyclic];
    // Re-attach a $defs island holding exactly the cyclic definitions so a
    // ref-keeping serializer (openai/anthropic/bedrock) can emit valid recursion.
    const island: Record<string, unknown> = {};
    for (const ptr of cyclic) {
      const name = defNameFromPointer(ptr);
      if (name !== undefined && defs[name] !== undefined) {
        island[name] = defs[name];
      }
    }
    if (Object.keys(island).length > 0) extra["normalize.cyclesDefs"] = island;
  }
  if (Object.keys(extra).length > 0) result.extra = extra;

  return result;
}

// ── $defs / definitions collection ───────────────────────────────────────────

/**
 * Gather the definition pool from both `$defs` and legacy `definitions`. `$defs`
 * wins on a key collision; both present is a notable-but-harmless `info`.
 */
export function collectDefs(root: ObjectSchema, notes: NoteCollector): Record<string, unknown> {
  const dollar = asRecord(root.$defs);
  const legacy = asRecord(root.definitions);
  const hasDollar = Object.keys(dollar).length > 0;
  const hasLegacy = Object.keys(legacy).length > 0;
  if (hasDollar && hasLegacy) {
    notes.info("Schema has both `$defs` and `definitions`; merged with `$defs` taking precedence");
  }
  return { ...legacy, ...dollar };
}

// ── JSON Pointer resolution ───────────────────────────────────────────────────

/**
 * Resolve a local JSON Pointer (e.g. "#/$defs/Pet", "#/definitions/Node",
 * "#/properties/x/items") against the root schema and the collected defs.
 * Returns undefined if it cannot be resolved. Never throws.
 */
export function resolvePointer(
  ref: string,
  root: ObjectSchema,
  defs: Record<string, unknown>,
): unknown {
  if (!ref.startsWith("#")) return undefined; // only local refs are inlinable
  const body = ref.slice(1);
  if (body === "" || body === "/") return root; // "#" = whole root (self-reference)
  if (!body.startsWith("/")) return undefined;
  const rawTokens = body.slice(1).split("/");
  const tokens = rawTokens.map(unescapePointerToken);

  // Fast path: "#/$defs/Name" or "#/definitions/Name" resolves via the pool.
  if (tokens.length === 2 && (tokens[0] === "$defs" || tokens[0] === "definitions")) {
    const name = tokens[1];
    if (name !== undefined && defs[name] !== undefined) return defs[name];
  }

  // General path: walk the root object token by token.
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const idx = Number.parseInt(token, 10);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** JSON Pointer unescaping: `~1` -> `/`, `~0` -> `~` (order matters). */
function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** For a pointer like "#/$defs/Node", return "Node"; else undefined. */
function defNameFromPointer(ref: string): string | undefined {
  const tokens = ref.slice(1).replace(/^\//, "").split("/").map(unescapePointerToken);
  if (tokens.length === 2 && (tokens[0] === "$defs" || tokens[0] === "definitions")) {
    return tokens[1];
  }
  return undefined;
}

// ── Ref inlining with cycle detection ─────────────────────────────────────────

/**
 * Recursively inline `$ref`s into a self-contained schema. `activeRefs` is the
 * stack of pointers currently being inlined; a `$ref` back onto one of them is a
 * cycle — recorded in `cyclic` and left in place (never inlined infinitely).
 *
 * A `$ref` with sibling keywords (e.g. `{ $ref, description }`) inlines the
 * target, then shallow-merges the siblings over it (siblings win) with an `info`.
 */
export function inlineRefs(
  schema: JSONSchema,
  defs: Record<string, unknown>,
  notes: NoteCollector,
  activeRefs: string[],
  cyclic: Set<string>,
  maxDepth: number,
  path: string,
  root?: ObjectSchema,
): JSONSchema {
  if (typeof schema === "boolean") return schema;
  if (!isObjectSchema(schema)) return {};
  const rootSchema = root ?? schema;

  if (activeRefs.length > maxDepth) {
    notes.loss(`Ref inlining exceeded max depth (${maxDepth}); left a ref in place`, path);
    return schema;
  }

  const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
  if (ref !== undefined) {
    if (activeRefs.includes(ref)) {
      // Cycle: this ref is already being inlined higher in the stack.
      cyclic.add(ref);
      notes.info(`Detected a recursive $ref cycle at "${ref}"; kept as a reference`, path);
      return { $ref: ref };
    }
    const target = resolvePointer(ref, rootSchema, defs);
    if (target === undefined) {
      notes.warning(`Unresolved $ref "${ref}"; left in place`, path);
      return schema;
    }
    const resolved = inlineRefs(
      asSchema(target),
      defs,
      notes,
      [...activeRefs, ref],
      cyclic,
      maxDepth,
      path,
      rootSchema,
    );
    // Merge sibling keywords (everything except $ref) over the resolved target.
    const siblings = siblingKeywords(schema);
    if (Object.keys(siblings).length > 0 && isObjectSchema(resolved)) {
      notes.info(`Merged sibling keywords over an inlined $ref "${ref}"`, path);
      return { ...resolved, ...siblings };
    }
    return resolved;
  }

  // No $ref here: recurse into every subschema position.
  const out: ObjectSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((SUBSCHEMA_KEYS as readonly string[]).includes(key)) {
      out[key] = inlineRefs(
        asSchema(value),
        defs,
        notes,
        activeRefs,
        cyclic,
        maxDepth,
        `${path}.${key}`,
        rootSchema,
      );
    } else if ((SUBSCHEMA_MAP_KEYS as readonly string[]).includes(key)) {
      const map = asRecord(value);
      const outMap: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(map)) {
        outMap[name] = inlineRefs(
          asSchema(sub),
          defs,
          notes,
          activeRefs,
          cyclic,
          maxDepth,
          `${path}.${key}.${name}`,
          rootSchema,
        );
      }
      out[key] = outMap;
    } else if ((SUBSCHEMA_ARRAY_KEYS as readonly string[]).includes(key)) {
      const arr = asArray(value);
      out[key] = arr.map((sub, i) =>
        inlineRefs(
          asSchema(sub),
          defs,
          notes,
          activeRefs,
          cyclic,
          maxDepth,
          `${path}.${key}[${i}]`,
          rootSchema,
        ),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Everything on a `$ref` node except `$ref` itself. */
function siblingKeywords(schema: ObjectSchema): ObjectSchema {
  const { $ref: _ref, ...rest } = schema;
  return rest;
}

/**
 * Drop the top-level `$defs` / `definitions` blocks after inlining — they are no
 * longer referenced in the acyclic case (cyclic defs are re-attached as an
 * island in `extra` by the caller, not left on the schema).
 */
function stripDefs(schema: ObjectSchema): ObjectSchema {
  const { $defs: _d, definitions: _defn, ...rest } = schema;
  return rest;
}

// ── Nullability normalization ─────────────────────────────────────────────────

/**
 * Canonicalize every nullable spelling to the JSON-Schema union form
 * `type: ["T","null"]`. The OpenAPI `nullable: true` boolean is merged into the
 * type and removed. Recurses through every subschema position. Serializers own
 * the reverse mapping (union -> `nullable:true`) for dialects that want it.
 */
export function normalizeNullability(schema: JSONSchema, notes: NoteCollector, path: string): void {
  if (!isObjectSchema(schema)) return;

  if (schema.nullable === true) {
    const type = schema.type;
    if (typeof type === "string" && type !== "null") {
      schema.type = [type, "null"];
      notes.info(`Normalized \`nullable:true\` to type union ["${type}","null"]`, path);
    } else if (Array.isArray(type)) {
      if (!type.includes("null")) {
        schema.type = [...type, "null"];
        notes.info("Normalized `nullable:true` into the existing type union", path);
      }
    } else if (type === undefined) {
      // nullable with no type: nothing to union it into; just drop the keyword.
      notes.info("Dropped `nullable:true` with no `type` to union it into", path);
    }
    // biome-ignore lint/performance/noDelete: the key must be absent from the output JSON, not set to `undefined`.
    delete schema.nullable;
  } else if (schema.nullable === false) {
    // nullable:false is the default; drop it silently-ish as a reversible info.
    // biome-ignore lint/performance/noDelete: the key must be absent from the output JSON, not set to `undefined`.
    delete schema.nullable;
  }

  for (const key of SUBSCHEMA_KEYS) {
    if (key in schema) normalizeNullability(asSchema(schema[key]), notes, `${path}.${key}`);
  }
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = asRecord(schema[key]);
    for (const [name, sub] of Object.entries(map)) {
      normalizeNullability(asSchema(sub), notes, `${path}.${key}.${name}`);
    }
  }
  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    const arr = asArray(schema[key]);
    arr.forEach((sub, i) => normalizeNullability(asSchema(sub), notes, `${path}.${key}[${i}]`));
  }
}

// ── Depth measurement (used by the walker to flag nesting > 32) ───────────────

/** Max nesting depth of object/array subschemas. A flat object is depth 1. */
export function schemaDepth(schema: JSONSchema): number {
  if (!isObjectSchema(schema)) return 0;
  let max = 0;
  for (const key of SUBSCHEMA_KEYS) {
    if (key in schema) max = Math.max(max, schemaDepth(asSchema(schema[key])));
  }
  for (const key of SUBSCHEMA_MAP_KEYS) {
    for (const sub of Object.values(asRecord(schema[key]))) {
      max = Math.max(max, schemaDepth(asSchema(sub)));
    }
  }
  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    for (const sub of asArray(schema[key])) {
      max = Math.max(max, schemaDepth(asSchema(sub)));
    }
  }
  return max + 1;
}

/** Shared keyword-position lists, exported for the walker to reuse. */
export { SUBSCHEMA_KEYS, SUBSCHEMA_MAP_KEYS, SUBSCHEMA_ARRAY_KEYS };
