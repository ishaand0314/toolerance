/**
 * toolerance — convert one canonical tool/function definition into every provider
 * dialect (OpenAI Chat + Responses, Anthropic, Gemini Developer + Vertex, Bedrock)
 * and report exactly what each target cannot represent.
 *
 * The public API. The one-line entry points most users want are `convert`,
 * `convertAll`, and `lint`; everything else is exported for advanced use
 * (building a custom pipeline, inspecting the policy table, reusing the notes).
 */

// ── Core entry points ─────────────────────────────────────────────────────────
export {
  convert,
  convertAll,
  isDialect,
  PARSERS,
  SERIALIZERS,
  type ConvertOptions,
  type DialectResult,
} from "./convert.js";
export { lint, type LintOptions } from "./lint.js";

// ── Auto-detection + batch conversion ──────────────────────────────────────────
export {
  detectDialect,
  resolveFrom,
  extractTools,
  convertTools,
  convertAllTools,
  type DetectionResult,
  type BatchItemResult,
  type BatchAllItemResult,
} from "./convert.js";

// ── The IR and its readers ─────────────────────────────────────────────────────
export {
  DIALECTS,
  type Dialect,
  type JSONSchema,
  type ObjectSchema,
  type ToolDef,
  isObjectSchema,
  isBooleanSchema,
  asRecord,
  asArray,
  asString,
  asSchema,
  cloneSchema,
} from "./schema.js";

// ── The loss report ────────────────────────────────────────────────────────────
export {
  type ConvertResult,
  type LossNote,
  type Severity,
  NoteCollector,
  hasLoss,
} from "./notes.js";

// ── The pipeline stages (for building a custom flow) ───────────────────────────
export { normalize, type NormalizeOptions, schemaDepth } from "./normalize.js";
export type { ParseResult } from "./parse.js";
export { type SerializeOptions, applyOpenAIStrict } from "./serialize.js";

// ── The per-dialect policy table (the auditable divergence) ─────────────────────
export {
  POLICIES,
  walkSchema,
  GEMINI_TOGGLES,
  type DialectPolicy,
  type KeywordRule,
} from "./walk.js";
