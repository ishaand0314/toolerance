/**
 * `validate` — the hard "will the provider reject this at call time?" check.
 *
 * This is distinct from the other two questions the tool answers:
 *   - `lint` reports what a dialect would *reshape* (advisory notes).
 *   - `--strict` gates on information *loss* (a dropped constraint).
 *   - `validate` reports hard *rejections*: schemas a provider's API will refuse
 *     with a 400 regardless of loss — a name that breaks the provider's regex, a
 *     non-object root, or nesting past the provider limit.
 *
 * A tool can be lossless yet invalid (a legal name that is simply too long), or
 * lossy yet valid (a dropped `maxLength` still calls fine). So this needs its own
 * verdict, not a reuse of the lossiness note.
 *
 * Crucially, `validate` checks the schema the converter would ACTUALLY SEND: it
 * runs the real conversion for the target dialect first, then validates that
 * output. So a `["string","null"]` union — which the converter rewrites to
 * `nullable:true` for Gemini — validates clean, because the emitted schema is
 * valid even though the input spelling was not. This measures the deliverable,
 * not the draft. Never throws.
 */

import { type ConvertOptions, convert } from "./convert.js";
import { type Dialect, asArray, asRecord, asString } from "./schema.js";
import { POLICIES } from "./walk.js";

/** One reason a provider would reject the tool at call time. */
export interface ValidationError {
  /** Short machine-readable rule id, e.g. "name.pattern", "root.type", "depth". */
  readonly rule: string;
  /** Human-readable explanation of the rejection. */
  readonly message: string;
  /** Where it happens, e.g. "name" or "parameters". */
  readonly path?: string;
}

export interface ValidationResult {
  /** True when no hard rule is broken (the provider should accept the tool). */
  readonly valid: boolean;
  readonly errors: ValidationError[];
  /** The dialect the tool was validated against. */
  readonly dialect: Dialect;
}

export type ValidateOptions = ConvertOptions;

/**
 * Every provider's function/tool name rule is the same practical regex: letters,
 * digits, underscore, hyphen, 1–64 chars. (Anthropic and OpenAI both document
 * `^[a-zA-Z0-9_-]{1,64}$`; Gemini and Bedrock are at least as strict.)
 */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a tool against a dialect's hard acceptance rules. Converts `from` ->
 * `against` (so the schema checked is the one that would be sent), then checks
 * the name, the root type, and the nesting depth of the emitted output. Never
 * throws.
 */
export function validate(
  from: Dialect,
  against: Dialect,
  payload: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  const { output } = convert(from, against, payload, options);
  const policy = POLICIES[against];
  const errors: ValidationError[] = [];

  const { name, parameters } = extractNameAndParams(output, against);

  // ── Name rules ──────────────────────────────────────────────────────────────
  if (name.trim().length === 0) {
    errors.push({
      rule: "name.empty",
      message: "Tool name is empty; every provider requires a name",
      path: "name",
    });
  } else {
    if (name.length > policy.nameMaxLen) {
      errors.push({
        rule: "name.length",
        message: `Tool name is ${name.length} chars; ${against} rejects names longer than ${policy.nameMaxLen}`,
        path: "name",
      });
    }
    if (!NAME_PATTERN.test(name)) {
      errors.push({
        rule: "name.pattern",
        message: `Tool name "${name}" has characters ${against} rejects (allowed: letters, digits, underscore, hyphen)`,
        path: "name",
      });
    }
  }

  // ── Root must be an object schema ───────────────────────────────────────────
  if (!isRootObject(parameters)) {
    errors.push({
      rule: "root.type",
      message: `${against} requires the \`parameters\` root to be \`type:"object"\``,
      path: "parameters",
    });
  }

  // ── Nesting depth ───────────────────────────────────────────────────────────
  if (policy.maxNestingDepth !== undefined) {
    const depth = structuralDepth(parameters, policy.maxNestingDepth + 1);
    if (depth > policy.maxNestingDepth) {
      errors.push({
        rule: "depth",
        message: `Schema nests deeper than ${policy.maxNestingDepth} levels; ${against} may reject it`,
        path: "parameters",
      });
    }
  }

  return { valid: errors.length === 0, errors, dialect: against };
}

/** Pull the name and parameters schema out of any dialect's serialized envelope. */
function extractNameAndParams(
  output: unknown,
  dialect: Dialect,
): { name: string; parameters: unknown } {
  const o = asRecord(output);
  switch (dialect) {
    case "openai": {
      const fn = asRecord(o.function);
      return { name: asString(fn.name), parameters: fn.parameters };
    }
    case "anthropic":
      return { name: asString(o.name), parameters: o.input_schema };
    case "gemini-developer":
    case "gemini-vertex": {
      const decls = asArray(o.functionDeclarations);
      const first = asRecord(decls[0]);
      return { name: asString(first.name), parameters: first.parameters };
    }
    case "bedrock": {
      const spec = asRecord(o.toolSpec);
      const input = asRecord(spec.inputSchema);
      return { name: asString(spec.name), parameters: input.json };
    }
    default:
      // openai-responses and any flat shape.
      return { name: asString(o.name), parameters: o.parameters };
  }
}

/** The root object rule: `type:"object"` or a combinator that yields an object. */
function isRootObject(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
  const rec = schema as Record<string, unknown>;
  if (rec.type === "object") return true;
  return rec.anyOf !== undefined || rec.oneOf !== undefined || rec.allOf !== undefined;
}

/**
 * Bounded structural depth of a schema: how deep the nesting goes, capped at
 * `limit` so a pathological schema cannot make this recurse without bound.
 */
function structuralDepth(schema: unknown, limit: number, depth = 1): number {
  if (depth >= limit || typeof schema !== "object" || schema === null) return depth;
  let max = depth;
  for (const value of Object.values(schema)) {
    if (typeof value === "object" && value !== null) {
      const child = Array.isArray(value)
        ? Math.max(depth, ...value.map((v) => structuralDepth(v, limit, depth + 1)))
        : structuralDepth(value, limit, depth + 1);
      if (child > max) max = child;
      if (max >= limit) return max;
    }
  }
  return max;
}
