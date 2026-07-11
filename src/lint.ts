/**
 * `lint` — check a tool definition against a single dialect's own policy and
 * report what that dialect cannot represent, WITHOUT converting to a foreign
 * envelope. Answers "is this OpenAI tool safe to send to gemini-vertex?" in one
 * pass: parse it, normalize it, then walk it with the *target* dialect's policy
 * and surface the notes.
 *
 * This is deliberately not `convert(x, x)` — lint keeps the source envelope and
 * only measures schema-level lossiness against a chosen dialect, which is the
 * question you ask before you commit to a conversion.
 */

import { PARSERS } from "./convert.js";
import { normalize } from "./normalize.js";
import { type ConvertResult, NoteCollector } from "./notes.js";
import type { Dialect, ToolDef } from "./schema.js";
import { POLICIES, walkSchema } from "./walk.js";

export interface LintOptions {
  /** Cap for `$ref` inlining depth (forwarded to normalize). */
  readonly maxInlineDepth?: number;
}

/**
 * Parse `payload` as `from`, normalize it, then walk the normalized parameters
 * with `against`'s policy — reporting every keyword that dialect would drop or
 * transform. Returns the normalized `ToolDef` (source-shaped) plus the notes.
 * When `from === against`, this is a pure "what does this dialect lose?" check.
 */
export function lint(
  from: Dialect,
  against: Dialect,
  payload: unknown,
  options: LintOptions = {},
): ConvertResult<ToolDef> {
  const { tool: parsed, collector } = PARSERS[from](payload);
  const normalizeNotes = new NoteCollector();
  const normalizeOptions =
    options.maxInlineDepth !== undefined ? { maxInlineDepth: options.maxInlineDepth } : {};
  const tool = normalize(parsed, normalizeNotes, normalizeOptions);

  // Walk with the target's policy to surface drops/transforms, discarding the
  // rewritten schema — lint reports notes, it does not emit a converted schema.
  const walkNotes = new NoteCollector();
  walkSchema(tool.parameters, POLICIES[against], walkNotes, "parameters");

  return {
    output: tool,
    notes: [...collector.notes, ...normalizeNotes.notes, ...walkNotes.notes],
  };
}
