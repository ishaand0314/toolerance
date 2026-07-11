/**
 * The lossiness report — the actual product.
 *
 * Every conversion returns its output *and* a list of notes describing exactly
 * what changed or was dropped when a tool's JSON Schema crossed into a target
 * dialect. The rule: never throw on a lossy conversion, never convert silently.
 *
 * - "info":    a faithful, reversible change (e.g. `nullable:true` <-> `["T","null"]`,
 *              renaming `input_schema` -> `parameters`, `const` -> single-value `enum`).
 * - "warning": the schema is still valid but weaker (a dropped constraint like
 *              `maxLength`, or dropped `additionalProperties:false` making an object
 *              more permissive; a name a dialect can't represent).
 * - "loss":    semantics gone (a dropped `oneOf`/`not`, un-inlinable recursion, a
 *              whole keyword the target cannot express like `patternProperties`).
 *
 * `--strict` in the CLI exits non-zero if any note is a "loss".
 *
 * This shape is intentionally identical to llm-attrition's LossNote so the two
 * tools feel like one family.
 */

export type Severity = "info" | "warning" | "loss";

export interface LossNote {
  severity: Severity;
  /** Human-readable, e.g. "Dropped `patternProperties` (unsupported by gemini-vertex)". */
  message: string;
  /** Where it happened, e.g. "parameters.properties.tags". Optional. */
  path?: string;
}

export interface ConvertResult<T> {
  output: T;
  notes: LossNote[];
}

/**
 * A tiny accumulator so parsers, normalize, and serializers can record notes
 * without threading an array through every function. Order of insertion is
 * preserved.
 */
export class NoteCollector {
  private readonly _notes: LossNote[] = [];

  info(message: string, path?: string): void {
    this.push("info", message, path);
  }

  warning(message: string, path?: string): void {
    this.push("warning", message, path);
  }

  loss(message: string, path?: string): void {
    this.push("loss", message, path);
  }

  private push(severity: Severity, message: string, path?: string): void {
    const note: LossNote = path === undefined ? { severity, message } : { severity, message, path };
    this._notes.push(note);
  }

  /** A snapshot copy of the notes collected so far. */
  get notes(): LossNote[] {
    return [...this._notes];
  }

  /** True if any collected note is a "loss" (drives --strict). */
  hasLoss(): boolean {
    return this._notes.some((n) => n.severity === "loss");
  }
}

/** True if any note in the list is a "loss". Used by the CLI for --strict. */
export function hasLoss(notes: readonly LossNote[]): boolean {
  return notes.some((n) => n.severity === "loss");
}
