import { describe, expect, it } from "vitest";
import { convert } from "../src/convert.js";
import { parseOpenAI } from "../src/parse.js";

/**
 * Envelope reshaping: each dialect wraps the same schema differently, and the
 * parsers unwrap them. These tests exercise the wrapper-level behavior
 * (auto-detect, renames, multi-declaration handling) rather than keyword drops.
 */

describe("envelope: openai chat vs responses auto-detect", () => {
  it("a flat payload (no `function` wrapper) is parsed as the Responses shape", () => {
    const { tool, collector } = parseOpenAI({
      type: "function",
      name: "search",
      parameters: { type: "object" },
    });
    expect(tool.name).toBe("search");
    expect(collector.notes.some((n) => n.message.includes("Responses"))).toBe(true);
  });

  it("a chat payload with a `function` wrapper is parsed normally", () => {
    const { tool, collector } = parseOpenAI({
      type: "function",
      function: { name: "search", parameters: { type: "object" } },
    });
    expect(tool.name).toBe("search");
    expect(collector.notes.some((n) => n.message.includes("Responses"))).toBe(false);
  });

  it("openai chat -> responses flattens the envelope", () => {
    const { output } = convert("openai", "openai-responses", {
      type: "function",
      function: { name: "search", parameters: { type: "object" } },
    });
    const o = output as Record<string, unknown>;
    expect(o.name).toBe("search");
    expect(o.function).toBeUndefined();
  });
});

describe("envelope: anthropic rename round-trip", () => {
  it("openai -> anthropic renames parameters to input_schema", () => {
    const { output } = convert("openai", "anthropic", {
      type: "function",
      function: { name: "s", parameters: { type: "object" } },
    });
    expect((output as Record<string, unknown>).input_schema).toBeDefined();
  });

  it("anthropic -> openai renames input_schema back to parameters", () => {
    const { output } = convert("anthropic", "openai", {
      name: "s",
      input_schema: { type: "object" },
    });
    expect((output as { function: { parameters: unknown } }).function.parameters).toBeDefined();
  });
});

describe("envelope: gemini wrapper", () => {
  it("warns when a payload has more than one functionDeclaration", () => {
    const { notes } = convert("gemini-developer", "openai", {
      functionDeclarations: [
        { name: "a", parameters: { type: "object" } },
        { name: "b", parameters: { type: "object" } },
      ],
    });
    expect(notes.some((n) => n.message.includes("functionDeclarations"))).toBe(true);
  });

  it("vertex ref/defs are rewritten to $ref/$defs on parse", () => {
    const { output } = convert("gemini-vertex", "openai", {
      functionDeclarations: [
        {
          name: "s",
          parameters: {
            type: "object",
            properties: { p: { ref: "#/defs/P" } },
            defs: { P: { type: "string" } },
          },
        },
      ],
    });
    // After parse+normalize the ref should be inlined; openai output keeps the string.
    const params = (output as { function: { parameters: Record<string, unknown> } }).function
      .parameters;
    const p = (params.properties as Record<string, Record<string, unknown>>).p;
    expect(p.type).toBe("string");
  });
});

describe("envelope: bedrock wrapper", () => {
  it("unwraps toolSpec.inputSchema.json and re-wraps on output", () => {
    const { output } = convert("bedrock", "bedrock", {
      toolSpec: {
        name: "s",
        inputSchema: { json: { type: "object", properties: { x: { type: "string" } } } },
      },
    });
    const json = (output as { toolSpec: { inputSchema: { json: Record<string, unknown> } } })
      .toolSpec.inputSchema.json;
    expect(json.type).toBe("object");
  });
});
