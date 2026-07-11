import { describe, expect, it } from "vitest";
import { convert, convertAll } from "../src/convert.js";
import type { LossNote } from "../src/notes.js";

/**
 * Captured fixtures for behaviors that were tricky to get right — each is a
 * concrete schema that once exercised an edge case, kept as a regression guard.
 */

function find(notes: LossNote[], needle: string): LossNote | undefined {
  return notes.find((n) => n.message.toLowerCase().includes(needle.toLowerCase()));
}

describe("regressions", () => {
  it("the flagship anyOf + prefixItems + nullable schema diverges correctly across geminis", () => {
    const payload = {
      type: "function",
      function: {
        name: "search",
        parameters: {
          type: "object",
          properties: {
            filter: {
              oneOf: [{ type: "string" }, { type: "object", additionalProperties: false }],
            },
            coords: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] },
            score: { type: "number", minimum: 0, maximum: 1, nullable: true },
          },
          required: ["filter"],
        },
      },
    };
    const results = convertAll("openai", payload);
    const dev = results.find((r) => r.dialect === "gemini-developer");
    const vtx = results.find((r) => r.dialect === "gemini-vertex");
    if (!dev || !vtx) throw new Error("missing gemini results");

    // Developer keeps prefixItems (no loss for it); Vertex degrades it (loss).
    expect(find(dev.notes, "tuple `prefixitems`")).toBeUndefined();
    expect(find(vtx.notes, "tuple `prefixitems`")?.severity).toBe("loss");

    // Both rewrite oneOf -> anyOf (warning) and normalize nullable -> nullable:true.
    expect(find(dev.notes, "rewrote `oneof` to `anyof`")?.severity).toBe("warning");
    expect(find(vtx.notes, "nullable: true")?.severity).toBe("info");
  });

  it("a recursive $ref survives multi-hop into a ref-keeping dialect via the cycle island", () => {
    const payload = {
      name: "tree",
      input_schema: {
        type: "object",
        properties: { root: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: { children: { type: "array", items: { $ref: "#/$defs/Node" } } },
          },
        },
      },
    };
    // anthropic (ref-keeper) -> bedrock (ref-keeper): the $defs island is re-attached.
    const { output } = convert("anthropic", "bedrock", payload);
    const json = (output as { toolSpec: { inputSchema: { json: Record<string, unknown> } } })
      .toolSpec.inputSchema.json;
    expect(json.$defs).toBeDefined();
  });

  it("empty/garbage parameters normalize to an object schema, never throwing", () => {
    const { output } = convert("openai", "gemini-vertex", {
      type: "function",
      function: { name: "x", parameters: 42 },
    });
    const params = (
      output as { functionDeclarations: Array<{ parameters: Record<string, unknown> }> }
    ).functionDeclarations[0]?.parameters;
    expect(params?.type).toBe("object");
  });

  it("a bare functionDeclaration (no wrapper array) is still parsed", () => {
    const { output } = convert("gemini-developer", "anthropic", {
      name: "x",
      parameters: { type: "object", properties: { a: { type: "string" } } },
    });
    expect((output as { name: string }).name).toBe("x");
  });
});
