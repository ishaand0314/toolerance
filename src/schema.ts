/**
 * The canonical IR.
 *
 * Unlike llm-attrition (which invents a `Conversation` shape), this tool does
 * NOT invent a parameter representation: three of the four base dialects already
 * speak JSON Schema, so **the IR *is* JSON Schema** (a permissive typed subset)
 * plus a thin `ToolDef` envelope. That is the whole architectural bet — adding a
 * dialect is one parser + one serializer, never a pairwise converter.
 *
 * `JSONSchema` is deliberately a permissive *structural* type, not a full
 * nominal JSON-Schema library: parsers are permissive readers (junk coerces to
 * empty rather than throwing), keyword access goes through the reader helpers
 * below, and a strict nominal type would fight `noUncheckedIndexedAccess` and
 * force casts at every node. Unknown keywords are carried uniformly.
 */

/**
 * The conversion targets are **API formats**, not model vendors. Bedrock
 * Converse is a format even though it hosts many vendors' models, and Gemini is
 * split into two dialects because the Developer API and Vertex accept different
 * schema subsets — that split is the entire reason this tool exists.
 */
export const DIALECTS = [
  "openai", // Chat Completions: { type:"function", function:{ name, description, parameters } }
  "openai-responses", // Responses API: flattened { type:"function", name, description, parameters }
  "anthropic", // { name, description, input_schema }
  "gemini-developer", // functionDeclarations[], NARROWER OpenAPI subset ($ref/$defs form)
  "gemini-vertex", // functionDeclarations[], uses ref/defs (no $), no prefixItems/type:null
  "bedrock", // { toolSpec: { name, description, inputSchema: { json: {...} } } }
] as const;

export type Dialect = (typeof DIALECTS)[number];

export function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value);
}

/**
 * A JSON Schema node. Either the object form (any keyword may be present, values
 * are `unknown` and read through helpers) or a boolean schema (`true` = allow
 * anything, `false` = allow nothing — both are valid JSON Schema).
 */
export type JSONSchema = ObjectSchema | boolean;

/** The object form. Permissive on purpose — see the file header. */
export interface ObjectSchema {
  [keyword: string]: unknown;
}

/**
 * One tool/function definition, dialect-independent.
 *
 * `parameters` is canonical, ref-free JSON Schema *after* normalize runs. `extra`
 * stashes dialect-only envelope fields that have no IR home, keyed
 * "<dialect>.<field>" (e.g. "openai.strict") so a multi-hop conversion cannot
 * collide — the exact convention llm-attrition uses for `Message.extra`.
 */
export interface ToolDef {
  name: string;
  description?: string;
  parameters: JSONSchema;
  extra?: Record<string, unknown>;
}

// ── Type guards ──────────────────────────────────────────────────────────────

export function isObjectSchema(schema: JSONSchema): schema is ObjectSchema {
  return typeof schema === "object" && schema !== null;
}

export function isBooleanSchema(schema: JSONSchema): schema is boolean {
  return typeof schema === "boolean";
}

// ── Permissive reader helpers (shared by parse + normalize + walk) ────────────
//
// These never throw. A parser handed garbage lifts whatever it recognizes and
// coerces the rest to a safe empty value, so the pipeline stays "never throw,
// never silently corrupt": the honest record of what happened lives in the notes.

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Coerce an arbitrary value into a `JSONSchema`. A boolean stays a boolean
 * schema; an object stays an object schema; anything else (string, number,
 * null, array) becomes an empty object schema so the walker never chokes.
 */
export function asSchema(value: unknown): JSONSchema {
  if (typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as ObjectSchema;
  }
  return {};
}

/** Deep structural clone of a JSON-compatible value (schemas are JSON). */
export function cloneSchema<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The deepest structural nesting the pipeline will process. A well-formed tool
 * schema is nowhere near this deep; a schema deeper than this is almost always
 * pathological (accidental or adversarial) and would otherwise overflow the call
 * stack in the recursive clone/walk. We never want to throw, so
 * `boundedCloneSchema` truncates below this depth instead.
 */
export const MAX_STRUCTURAL_DEPTH = 200;

/**
 * Depth-bounded deep clone. Behaves like `cloneSchema` for normal schemas, but
 * any subtree deeper than `maxDepth` is replaced with an empty object schema and
 * `onTruncate` is invoked once (with the deepest path reached) so the caller can
 * record a note. This is the single guard that keeps every downstream recursive
 * pass (ref inlining, nullability, the dialect walker) within a safe stack depth,
 * upholding the never-throw contract on adversarially deep input. Never throws.
 */
export function boundedCloneSchema(
  value: unknown,
  maxDepth: number = MAX_STRUCTURAL_DEPTH,
  onTruncate?: (path: string) => void,
): unknown {
  let truncated = false;
  const notify = (path: string) => {
    if (!truncated) {
      truncated = true;
      onTruncate?.(path);
    }
  };
  const clone = (v: unknown, depth: number, path: string): unknown => {
    if (typeof v !== "object" || v === null) return v;
    if (depth >= maxDepth) {
      notify(path);
      return {};
    }
    if (Array.isArray(v)) {
      return v.map((item, i) => clone(item, depth + 1, `${path}[${i}]`));
    }
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
      out[k] = clone(sub, depth + 1, `${path}.${k}`);
    }
    return out;
  };
  return clone(value, 0, "parameters");
}
