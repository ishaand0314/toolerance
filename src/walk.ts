/**
 * The keyword walker + the per-dialect policy table.
 *
 * ── This file is where the two Gemini dialects diverge, and the divergence is
 * DATA, not two hand-written walkers. ───────────────────────────────────────────
 *
 * A single `walkSchema` recurses through every subschema position and applies a
 * `DialectPolicy` — a table of per-keyword rules (keep / drop / transform). The
 * `gemini-developer` and `gemini-vertex` policies sit adjacent below so the
 * narrow-vs-wide diff is literally readable. If that divergence lived in two
 * separate walkers it would silently drift and lie; as data it is auditable in
 * one place, and each contentious row carries a dated source so re-verification
 * is cheap.
 *
 * ── VERIFICATION DATE: 2026-07-11 ──────────────────────────────────────────────
 * Provider schema support (especially Gemini's) moves fast. Every Gemini row
 * below was re-checked against current docs on 2026-07-11. The tool path a
 * converter actually emits is `FunctionDeclaration.parameters` (an OpenAPI-style
 * Schema object whose root must be `type: object`), which is more constrained
 * than the newer `parametersJsonSchema` path — so these columns reflect the
 * conservative tool-path reality.
 *
 * The most important 2026-07-11 corrections vs the original July-2026 spec (which
 * was stale in the dangerous "unsupported" direction):
 *   - anyOf: NOW SUPPORTED on gemini-developer (spec said drop=loss). Only oneOf
 *     down-converts. Sources: ai.google.dev structured-output, blog.google
 *     structured-outputs (2025).
 *   - minimum/maximum: NOW SUPPORTED on gemini-developer (spec said drop).
 *   - $ref recursion via "$ref":"#": NOW SUPPORTED on gemini-developer.
 *   - Vertex uses ref/defs (no $), lacks prefixItems, rejects type:"null"
 *     (use nullable:true). Sources: cloud.google.com/vertex-ai .../rest/v1/Schema,
 *     litellm #8864, python-genai #1807.
 *
 * Each stale-risk keyword is gated by a single named boolean below, so a future
 * correction is a one-line + one-test change.
 */

import {
  SUBSCHEMA_ARRAY_KEYS,
  SUBSCHEMA_KEYS,
  SUBSCHEMA_MAP_KEYS,
  schemaDepth,
} from "./normalize.js";
import type { NoteCollector } from "./notes.js";
import type { Severity } from "./notes.js";
import { type Dialect, type JSONSchema, type ObjectSchema, asArray, asSchema } from "./schema.js";

// ── Stale-risk toggles (flip a single line when docs change; each has a test) ──
//
// 2026-07-11: all three verified true for the Developer API tool/structured path.
const GEMINI_DEVELOPER_SUPPORTS_ANYOF = true; // was false in the July-2026 spec
const GEMINI_DEVELOPER_SUPPORTS_MIN_MAX = true; // numeric bounds, added 2025
const GEMINI_DEVELOPER_SUPPORTS_PREFIX_ITEMS = true; // tuple arrays, JSON-schema path
// additionalProperties is accepted for structured output but was intermittently
// MALFORMED_FUNCTION_CALL on the *function-calling* path into Jan 2026, so we
// conservatively drop it (warning) for gemini-developer. Vertex supports it.
const GEMINI_DEVELOPER_ADDITIONAL_PROPERTIES_RELIABLE = false;

/** Formats every dialect keeps (temporal formats are broadly honored). */
const TEMPORAL_FORMATS = new Set(["date", "date-time", "time", "duration"]);

// ── Policy shape ──────────────────────────────────────────────────────────────

export type KeywordRule =
  | { action: "keep" }
  | { action: "drop"; severity: Severity; note: string }
  | {
      action: "transform";
      severity: Severity;
      note: string;
      /** Return the replacement keyword(s) to merge in place of this one. */
      apply: (value: unknown, schema: ObjectSchema) => Record<string, unknown>;
    };

export interface DialectPolicy {
  readonly dialect: Dialect;
  /** Per-keyword rule; any keyword not listed defaults to `keep`. */
  readonly rules: Readonly<Record<string, KeywordRule>>;
  /** How nullability is emitted: canonical union, or the OpenAPI `nullable` flag. */
  readonly nullability: "union" | "nullable-flag";
  /** How `$ref`/`$defs` are named on output. */
  readonly refStyle: "dollar" | "no-dollar" | "inline-only";
  /** Flag object nesting deeper than this (undefined = no limit). */
  readonly maxNestingDepth?: number;
  /** Max name length before flagging (dots are always flagged). */
  readonly nameMaxLen: number;
  /** Description length before flagging (undefined = no limit). */
  readonly descriptionMaxLen?: number;
}

// ── Shared rule fragments ─────────────────────────────────────────────────────

const DROP_ONEOF_TO_ANYOF: KeywordRule = {
  action: "transform",
  severity: "warning",
  note: "Rewrote `oneOf` to `anyOf` (Gemini has no `oneOf`; exclusivity is not enforced)",
  apply: (value) => ({ anyOf: value }),
};

const DROP_LOSS = (keyword: string): KeywordRule => ({
  action: "drop",
  severity: "loss",
  note: `Dropped \`${keyword}\` (unsupported by Gemini function declarations)`,
});

const DROP_WARNING = (keyword: string, why: string): KeywordRule => ({
  action: "drop",
  severity: "warning",
  note: `Dropped \`${keyword}\` (${why})`,
});

const CONST_TO_ENUM: KeywordRule = {
  action: "transform",
  severity: "info",
  note: "Rewrote `const` to a single-value `enum` (Gemini has no `const`)",
  apply: (value) => ({ enum: [value] }),
};

// A `format` rule that keeps temporal formats and drops others with a warning.
const FORMAT_TEMPORAL_ONLY: KeywordRule = {
  action: "transform",
  severity: "warning",
  note: "Dropped non-temporal `format` (Gemini honors only enum/number/temporal formats)",
  apply: (value) =>
    typeof value === "string" && TEMPORAL_FORMATS.has(value) ? { format: value } : {},
};

// ── The two Gemini policies, side by side (the product) ───────────────────────
//
// Read these two objects together: every line that differs is a real, verified
// Developer-vs-Vertex divergence.

const GEMINI_DEVELOPER_POLICY: DialectPolicy = {
  dialect: "gemini-developer",
  nullability: "nullable-flag",
  refStyle: "dollar", // Developer JSON-schema path uses $ref/$defs
  maxNestingDepth: 32,
  nameMaxLen: 64,
  rules: {
    // Combinators
    anyOf: GEMINI_DEVELOPER_SUPPORTS_ANYOF ? { action: "keep" } : DROP_LOSS("anyOf"),
    oneOf: DROP_ONEOF_TO_ANYOF,
    allOf: DROP_LOSS("allOf"),
    not: DROP_LOSS("not"),
    // Object constraints
    additionalProperties: GEMINI_DEVELOPER_ADDITIONAL_PROPERTIES_RELIABLE
      ? { action: "keep" }
      : DROP_WARNING(
          "additionalProperties",
          "unreliable on the gemini-developer function-calling path",
        ),
    patternProperties: DROP_LOSS("patternProperties"),
    propertyNames: DROP_LOSS("propertyNames"),
    // Numeric bounds (corrected 2026-07-11: now supported)
    minimum: GEMINI_DEVELOPER_SUPPORTS_MIN_MAX
      ? { action: "keep" }
      : DROP_WARNING("minimum", "unsupported"),
    maximum: GEMINI_DEVELOPER_SUPPORTS_MIN_MAX
      ? { action: "keep" }
      : DROP_WARNING("maximum", "unsupported"),
    // Arrays
    prefixItems: GEMINI_DEVELOPER_SUPPORTS_PREFIX_ITEMS
      ? { action: "keep" }
      : DROP_LOSS("prefixItems"),
    // Values
    const: CONST_TO_ENUM,
    format: FORMAT_TEMPORAL_ONLY,
  },
};

const GEMINI_VERTEX_POLICY: DialectPolicy = {
  dialect: "gemini-vertex",
  nullability: "nullable-flag",
  refStyle: "no-dollar", // Vertex uses ref/defs WITHOUT the dollar sign
  maxNestingDepth: 32,
  nameMaxLen: 64,
  rules: {
    // Combinators — Vertex keeps anyOf, rewrites oneOf, drops the rest.
    anyOf: { action: "keep" },
    oneOf: DROP_ONEOF_TO_ANYOF,
    allOf: DROP_LOSS("allOf"),
    not: DROP_LOSS("not"),
    // Object constraints — Vertex DOES support additionalProperties (divergence).
    additionalProperties: { action: "keep" },
    patternProperties: DROP_LOSS("patternProperties"),
    propertyNames: DROP_LOSS("propertyNames"),
    // Numeric bounds — supported.
    minimum: { action: "keep" },
    maximum: { action: "keep" },
    // Arrays — Vertex has NO prefixItems (divergence): downgrade to homogeneous items.
    prefixItems: {
      action: "transform",
      severity: "loss",
      note: "Dropped tuple `prefixItems` for gemini-vertex (no tuple support); use homogeneous `items`",
      apply: (value) => {
        const arr = asArray(value);
        const first = arr[0];
        return first !== undefined ? { items: first } : {};
      },
    },
    // Values
    const: CONST_TO_ENUM,
    format: FORMAT_TEMPORAL_ONLY,
  },
};

/** Dialects that keep the standard JSON-Schema subset untouched (no drops). */
function keeperPolicy(dialect: Dialect): DialectPolicy {
  return {
    dialect,
    nullability: "union",
    refStyle: "dollar",
    nameMaxLen: 64,
    rules: {}, // keep everything
  };
}

export const POLICIES: Record<Dialect, DialectPolicy> = {
  openai: keeperPolicy("openai"),
  "openai-responses": keeperPolicy("openai-responses"),
  anthropic: keeperPolicy("anthropic"),
  bedrock: keeperPolicy("bedrock"),
  "gemini-developer": GEMINI_DEVELOPER_POLICY,
  "gemini-vertex": GEMINI_VERTEX_POLICY,
};

// ── The walker ────────────────────────────────────────────────────────────────

/**
 * Walk a ref-free schema, applying `policy` to every keyword at every node, and
 * return the dialect-shaped schema. Emits one note per drop/transform with a
 * `path`. Never throws.
 */
export function walkSchema(
  schema: JSONSchema,
  policy: DialectPolicy,
  notes: NoteCollector,
  path: string,
): JSONSchema {
  if (typeof schema === "boolean") {
    // A boolean subschema (true/false). Keepers keep it; the Gemini policies map
    // it to an empty/absent object since their Schema object has no boolean form.
    if (policy.dialect.startsWith("gemini")) {
      return schema === true ? {} : {};
    }
    return schema;
  }
  if (typeof schema !== "object" || schema === null) return {};

  // Nesting-depth flag (once, at the root of a too-deep subtree).
  if (
    policy.maxNestingDepth !== undefined &&
    path === "parameters" &&
    schemaDepth(schema) > policy.maxNestingDepth
  ) {
    notes.warning(
      `Schema nests deeper than ${policy.maxNestingDepth} levels; ${policy.dialect} may reject or truncate it`,
      path,
    );
  }

  const out: ObjectSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    const rule = policy.rules[key];

    // First, apply a keyword-level rule if one exists.
    if (rule !== undefined && rule.action !== "keep") {
      if (rule.action === "drop") {
        notes[rule.severity](rule.note, `${path}.${key}`);
        continue;
      }
      // transform
      notes[rule.severity](rule.note, `${path}.${key}`);
      const replacement = rule.apply(value, schema);
      // Recurse into the replacement's subschema values so nested keywords are
      // still policed (e.g. oneOf -> anyOf must still walk each branch).
      for (const [rk, rv] of Object.entries(replacement)) {
        out[rk] = walkKeywordValue(rk, rv, policy, notes, `${path}.${rk}`);
      }
      continue;
    }

    // Otherwise keep the keyword, recursing into subschema positions.
    out[key] = walkKeywordValue(key, value, policy, notes, `${path}.${key}`);
  }

  // Nullability: convert canonical union -> nullable flag where the dialect wants it.
  if (policy.nullability === "nullable-flag") {
    applyNullableFlag(out, notes, path);
  }

  return out;
}

/** Recurse into a keyword's value if it holds subschema(s); else pass through. */
function walkKeywordValue(
  key: string,
  value: unknown,
  policy: DialectPolicy,
  notes: NoteCollector,
  path: string,
): unknown {
  if ((SUBSCHEMA_KEYS as readonly string[]).includes(key)) {
    // A boolean in a single-subschema slot (e.g. `additionalProperties:false`,
    // `items:true`) is a meaningful constraint, not a type node — preserve it
    // verbatim. Only the whole-schema boolean case gets the gemini object mapping.
    if (typeof value === "boolean") return value;
    return walkSchema(asSchema(value), policy, notes, path);
  }
  if ((SUBSCHEMA_MAP_KEYS as readonly string[]).includes(key)) {
    const map =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const outMap: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(map)) {
      outMap[name] = walkSchema(asSchema(sub), policy, notes, `${path}.${name}`);
    }
    return outMap;
  }
  if ((SUBSCHEMA_ARRAY_KEYS as readonly string[]).includes(key)) {
    return asArray(value).map((sub, i) =>
      walkSchema(asSchema(sub), policy, notes, `${path}[${i}]`),
    );
  }
  return value;
}

/**
 * Turn a canonical nullable type-union `["T","null"]` into the OpenAPI
 * `nullable: true` + scalar `type` form that Gemini's classic Schema object
 * wants. Vertex in particular rejects `type: "null"`, so this is required, not
 * cosmetic.
 */
function applyNullableFlag(schema: ObjectSchema, notes: NoteCollector, path: string): void {
  const type = schema.type;
  if (Array.isArray(type) && type.includes("null")) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length === 1) {
      schema.type = nonNull[0];
      schema.nullable = true;
      notes.info('Converted type union ["T","null"] to `nullable: true`', path);
    } else if (nonNull.length === 0) {
      // Only "null" — leave as-is; nothing meaningful to flag.
      schema.type = "null";
    } else {
      // Multi-type union minus null: Gemini can't express it; keep union, flag it.
      schema.type = nonNull;
      schema.nullable = true;
      notes.warning(
        "Multi-type nullable union collapsed to `nullable:true` over a type array; Gemini may not honor all members",
        path,
      );
    }
  } else if (type === "null") {
    // Bare null type — Vertex rejects it. Best effort: keep, but flag.
    notes.warning('`type: "null"` may be rejected by gemini-vertex; prefer `nullable`', path);
  }
}

/** Expose the toggles for tests that assert both sides of a stale-risk row. */
export const GEMINI_TOGGLES = {
  developerSupportsAnyOf: GEMINI_DEVELOPER_SUPPORTS_ANYOF,
  developerSupportsMinMax: GEMINI_DEVELOPER_SUPPORTS_MIN_MAX,
  developerSupportsPrefixItems: GEMINI_DEVELOPER_SUPPORTS_PREFIX_ITEMS,
  developerAdditionalPropertiesReliable: GEMINI_DEVELOPER_ADDITIONAL_PROPERTIES_RELIABLE,
} as const;
