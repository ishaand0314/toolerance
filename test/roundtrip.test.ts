import { describe, expect, it } from "vitest";
import { convert } from "../src/convert.js";
import type { LossNote } from "../src/notes.js";
import { DIALECTS } from "../src/schema.js";

/**
 * Round-trip identity: a schema written in a dialect's own representable subset,
 * converted from that dialect back to itself, comes out semantically identical
 * with no `loss` note. We use a schema every dialect can represent (plain scalar
 * object) so one fixture serves all six.
 */

/** A schema in the universal safe subset (representable by every dialect). */
const safeParameters = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    verbose: { type: "boolean" },
  },
  required: ["query"],
};

/** Wrap `safeParameters` in each dialect's own envelope so from===to is a true identity. */
function envelopeFor(dialect: string): unknown {
  switch (dialect) {
    case "openai":
      return { type: "function", function: { name: "search", parameters: safeParameters } };
    case "openai-responses":
      return { type: "function", name: "search", parameters: safeParameters };
    case "anthropic":
      return { name: "search", input_schema: safeParameters };
    case "gemini-developer":
    case "gemini-vertex":
      return { functionDeclarations: [{ name: "search", parameters: safeParameters }] };
    case "bedrock":
      return { toolSpec: { name: "search", inputSchema: { json: safeParameters } } };
    default:
      throw new Error(`unhandled dialect ${dialect}`);
  }
}

/** Pull the parameters schema back out of any dialect's output for comparison. */
function paramsOf(output: unknown): unknown {
  const o = output as Record<string, unknown>;
  if (o.functionDeclarations) {
    return (o.functionDeclarations as Array<{ parameters: unknown }>)[0]?.parameters;
  }
  if (o.function) return (o.function as { parameters: unknown }).parameters;
  if (o.input_schema) return o.input_schema;
  if (o.toolSpec) return (o.toolSpec as { inputSchema: { json: unknown } }).inputSchema.json;
  return o.parameters;
}

function hasLossNote(notes: LossNote[]): boolean {
  return notes.some((n) => n.severity === "loss");
}

describe("roundtrip identity within each dialect's subset", () => {
  for (const dialect of DIALECTS) {
    it(`${dialect} -> ${dialect} preserves a representable schema with no loss`, () => {
      const { output, notes } = convert(dialect, dialect, envelopeFor(dialect));
      expect(paramsOf(output)).toEqual(safeParameters);
      expect(hasLossNote(notes)).toBe(false);
    });
  }
});
