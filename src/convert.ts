/**
 * The composition layer: `parse -> normalize -> serialize`, wired for all six
 * dialects and for the `--to all` matrix.
 *
 * This is the whole architecture in one file: a `PARSERS` record (one reader per
 * source dialect), a `SERIALIZERS` record (one writer per target dialect), and
 * two entry points — `convert` (one source, one target) and `convertAll` (one
 * source, every target). Notes are concatenated in pipeline order — parser
 * notes, then normalize notes, then serializer notes — so the report reads top to
 * bottom exactly as the transformation happened. Nothing throws.
 */

import { type DetectionResult, detectDialect } from "./detect.js";
import { normalize } from "./normalize.js";
import { type ConvertResult, type LossNote, NoteCollector } from "./notes.js";
import {
  type ParseResult,
  parseAnthropic,
  parseBedrock,
  parseGeminiDeveloper,
  parseGeminiVertex,
  parseOpenAI,
  parseOpenAIResponses,
} from "./parse.js";
import { DIALECTS, type Dialect, type ToolDef, asArray, asRecord } from "./schema.js";
import {
  type SerializeOptions,
  toAnthropic,
  toBedrock,
  toGeminiDeveloper,
  toGeminiVertex,
  toOpenAI,
  toOpenAIResponses,
} from "./serialize.js";

export { isDialect } from "./schema.js";
export { detectDialect, type DetectionResult } from "./detect.js";

/** Options threaded through a conversion. */
export interface ConvertOptions extends SerializeOptions {
  /** Cap for `$ref` inlining depth (forwarded to normalize). */
  readonly maxInlineDepth?: number;
}

/** One parser per source dialect. Envelope-unwrap only; permissive; never throws. */
export const PARSERS: Record<Dialect, (payload: unknown) => ParseResult> = {
  openai: parseOpenAI,
  "openai-responses": parseOpenAIResponses,
  anthropic: parseAnthropic,
  "gemini-developer": parseGeminiDeveloper,
  "gemini-vertex": parseGeminiVertex,
  bedrock: parseBedrock,
};

/**
 * One serializer per target dialect, normalized to a single signature
 * `(tool, priors, options) -> ConvertResult<unknown>`. The two OpenAI dialects
 * read `options.openaiStrict`; the rest ignore it, which keeps the record
 * homogeneous so `convert`/`convertAll` never branch on the target.
 */
export const SERIALIZERS: Record<
  Dialect,
  (tool: ToolDef, priors: readonly LossNote[], options: SerializeOptions) => ConvertResult<unknown>
> = {
  openai: (tool, priors, options) => toOpenAI(tool, priors, options),
  "openai-responses": (tool, priors, options) => toOpenAIResponses(tool, priors, options),
  anthropic: (tool, priors) => toAnthropic(tool, priors),
  "gemini-developer": (tool, priors) => toGeminiDeveloper(tool, priors),
  "gemini-vertex": (tool, priors) => toGeminiVertex(tool, priors),
  bedrock: (tool, priors) => toBedrock(tool, priors),
};

/**
 * Parse a payload in the `from` dialect and normalize it to the canonical IR,
 * returning the tool plus the accumulated parse+normalize notes (in order).
 * Shared by `convert` and `convertAll` so the source is read exactly once.
 */
function parseAndNormalize(
  from: Dialect,
  payload: unknown,
  options: ConvertOptions,
): { tool: ToolDef; priors: LossNote[] } {
  const { tool: parsed, collector } = PARSERS[from](payload);
  const normalizeNotes = new NoteCollector();
  const normalizeOptions =
    options.maxInlineDepth !== undefined ? { maxInlineDepth: options.maxInlineDepth } : {};
  const tool = normalize(parsed, normalizeNotes, normalizeOptions);
  return { tool, priors: [...collector.notes, ...normalizeNotes.notes] };
}

/**
 * Convert a tool definition from one dialect to another. Returns the target
 * payload plus every note the pipeline produced, in order. Never throws.
 */
export function convert(
  from: Dialect,
  to: Dialect,
  payload: unknown,
  options: ConvertOptions = {},
): ConvertResult<unknown> {
  const { tool, priors } = parseAndNormalize(from, payload, options);
  return SERIALIZERS[to](tool, priors, options);
}

/** A `--to all` result: the per-dialect payload and notes for one target. */
export interface DialectResult {
  dialect: Dialect;
  output: unknown;
  notes: LossNote[];
}

/**
 * Convert one source payload to every dialect. Parse + normalize run once; each
 * target serializes from the same canonical IR. The normalize notes are shared
 * across all targets (they describe the source, not the target) so they appear
 * once per target's note list, keeping each target's report self-contained.
 */
export function convertAll(
  from: Dialect,
  payload: unknown,
  options: ConvertOptions = {},
): DialectResult[] {
  const { tool, priors } = parseAndNormalize(from, payload, options);
  return DIALECTS.map((dialect) => {
    const { output, notes } = SERIALIZERS[dialect](tool, priors, options);
    return { dialect, output, notes };
  });
}

// ── Auto-detection + batch conversion ─────────────────────────────────────────

/**
 * Resolve a source dialect that may be the literal `"auto"`. When `from` is
 * `"auto"`, detect it from the payload shape; when detection fails, throw a
 * plain Error (the only throwing path in this file, used by the CLI's own
 * try/catch to ask for an explicit `--from`). A concrete dialect passes through.
 */
export function resolveFrom(
  from: Dialect | "auto",
  payload: unknown,
): { dialect: Dialect; detection: DetectionResult | null } {
  if (from !== "auto") return { dialect: from, detection: null };
  const detection = detectDialect(payload);
  if (detection === null) {
    throw new Error(
      "Could not auto-detect the source dialect; pass an explicit --from (openai, openai-responses, anthropic, gemini-developer, gemini-vertex, bedrock)",
    );
  }
  return { dialect: detection.dialect, detection };
}

/**
 * Pull the individual tool payloads out of a multi-tool container. Accepts:
 *   - a bare array of tool payloads,
 *   - an OpenAI `{ tools: [...] }` block,
 *   - a Gemini `{ functionDeclarations: [...] }` block (each declaration becomes
 *     one tool, so a batch of Gemini tools round-trips),
 *   - a single tool payload (returned as a one-element list).
 * Never throws; junk collapses to a single-element list containing the junk,
 * which the parser will then coerce.
 */
export function extractTools(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  if (Array.isArray(root.tools)) return root.tools;
  // A multi-declaration Gemini block: split into one payload per declaration so
  // each converts independently. A single-declaration block stays whole (its
  // parser handles the wrapper).
  const decls = asArray(root.functionDeclarations);
  if (decls.length > 1) {
    return decls.map((d) => ({ functionDeclarations: [d] }));
  }
  return [payload];
}

/** One tool's result inside a batch conversion. */
export interface BatchItemResult {
  /** 0-based index of the tool in the input batch. */
  readonly index: number;
  readonly output: unknown;
  readonly notes: LossNote[];
}

/**
 * Convert every tool in a batch payload from one dialect to another. Each tool
 * is converted independently; one tool's notes never bleed into another's. A
 * single-tool payload yields a one-element result. Never throws.
 */
export function convertTools(
  from: Dialect,
  to: Dialect,
  payload: unknown,
  options: ConvertOptions = {},
): BatchItemResult[] {
  return extractTools(payload).map((toolPayload, index) => {
    const { output, notes } = convert(from, to, toolPayload, options);
    return { index, output, notes };
  });
}

/** One tool's `--to all` matrix inside a batch. */
export interface BatchAllItemResult {
  readonly index: number;
  readonly results: DialectResult[];
}

/** Batch form of `convertAll`: every tool, to every dialect. Never throws. */
export function convertAllTools(
  from: Dialect,
  payload: unknown,
  options: ConvertOptions = {},
): BatchAllItemResult[] {
  return extractTools(payload).map((toolPayload, index) => ({
    index,
    results: convertAll(from, toolPayload, options),
  }));
}
