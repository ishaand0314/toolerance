/**
 * Source-dialect auto-detection.
 *
 * `--from auto` and the library `detectDialect` guess which dialect a payload is
 * written in from the shape of its envelope. The wire envelopes are distinct
 * enough that this is reliable in the common case: each dialect wraps its schema
 * differently (`.function`, `.input_schema`, `.functionDeclarations`,
 * `.toolSpec`). Where two dialects share a wrapper (the two Geminis) or a shape
 * is ambiguous (a flat `{name, parameters}` could be OpenAI Responses), we return
 * the safest superset reader and let the pipeline notes explain any reshape.
 *
 * Never throws: an unrecognizable payload returns `null`, and the caller decides
 * what to do (the CLI treats that as a usage error asking for an explicit --from).
 */

import { MAX_STRUCTURAL_DEPTH, asArray, asRecord } from "./schema.js";
import type { Dialect } from "./schema.js";

/** A detection result: the guessed dialect and why, or null if unrecognizable. */
export interface DetectionResult {
  readonly dialect: Dialect;
  /** One-line, user-facing reason the shape was matched. */
  readonly reason: string;
}

/**
 * Guess the source dialect of a single tool payload. Returns null when no
 * envelope is recognized. The order matters: the most specific, unambiguous
 * wrappers are tested first.
 */
export function detectDialect(payload: unknown): DetectionResult | null {
  const root = asRecord(payload);

  // Bedrock: the only dialect with a `toolSpec` wrapper.
  if ("toolSpec" in root) {
    return { dialect: "bedrock", reason: "has a `toolSpec` wrapper (Bedrock)" };
  }

  // Gemini: the only dialect with `functionDeclarations`. Developer vs Vertex
  // share this wrapper; we distinguish by the ref spelling Vertex uses (`ref`/
  // `defs` without the `$`), defaulting to Developer otherwise.
  if ("functionDeclarations" in root) {
    const decls = asArray(root.functionDeclarations);
    // Check every declaration's schema for the Vertex `ref`/`defs` spelling, not
    // just the first — a later tool may be the one that carries it.
    const anyVertex = decls.some((d) => usesVertexRefStyle(asRecord(d).parameters));
    if (anyVertex) {
      return {
        dialect: "gemini-vertex",
        reason: "has `functionDeclarations` with Vertex `ref`/`defs` (no `$`)",
      };
    }
    return {
      dialect: "gemini-developer",
      reason: "has `functionDeclarations` (Gemini Developer)",
    };
  }

  // Anthropic: the only dialect that names its schema `input_schema`.
  if ("input_schema" in root) {
    return { dialect: "anthropic", reason: "has an `input_schema` (Anthropic)" };
  }

  // OpenAI Chat: a `function` wrapper.
  if ("function" in root) {
    return { dialect: "openai", reason: "has a `function` wrapper (OpenAI Chat)" };
  }

  // OpenAI Responses: flat `{ type:"function", name, parameters }`. This is the
  // catch-all for a bare, unwrapped tool, so keep it last.
  if ("name" in root || "parameters" in root) {
    return {
      dialect: "openai-responses",
      reason: "is a flat `{ name, parameters }` shape (OpenAI Responses)",
    };
  }

  return null;
}

/**
 * True if a schema uses Vertex-style `ref`/`defs` keys anywhere in the tree. The
 * un-prefixed spelling can appear nested inside a property, so this recurses the
 * whole schema (bounded, so a pathologically deep input cannot overflow the
 * stack). The `$`-prefixed forms are canonical / everyone else.
 */
function usesVertexRefStyle(schema: unknown, depth = 0): boolean {
  if (depth >= MAX_STRUCTURAL_DEPTH) return false;
  if (typeof schema !== "object" || schema === null) return false;
  if (Array.isArray(schema)) {
    return schema.some((item) => usesVertexRefStyle(item, depth + 1));
  }
  const rec = schema as Record<string, unknown>;
  if ("defs" in rec && !("$defs" in rec)) return true;
  if (typeof rec.ref === "string" && !("$ref" in rec)) return true;
  for (const value of Object.values(rec)) {
    if (usesVertexRefStyle(value, depth + 1)) return true;
  }
  return false;
}
