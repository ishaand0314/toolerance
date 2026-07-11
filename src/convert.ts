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
import { DIALECTS, type Dialect, type ToolDef } from "./schema.js";
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
