import { describe, expect, it } from "vitest";
import { validate } from "../src/validate.js";

/**
 * `validate` answers the hard call-time question: would the provider reject this
 * tool? It is distinct from `lint` (reshaping) and `--strict` (loss). It runs the
 * real conversion first, so it judges the schema that would actually be sent.
 */

function tool(name: string, parameters: unknown) {
  return { type: "function", function: { name, parameters } };
}

describe("validate: name rules", () => {
  it("accepts a clean tool", () => {
    const r = validate("openai", "anthropic", tool("get_weather", { type: "object" }));
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("rejects an empty name", () => {
    const r = validate("openai", "anthropic", tool("", { type: "object" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.rule === "name.empty")).toBe(true);
  });

  it("rejects a name with dots", () => {
    const r = validate("openai", "anthropic", tool("my.tool", { type: "object" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.rule === "name.pattern")).toBe(true);
  });

  it("rejects an over-length name", () => {
    const r = validate("openai", "openai", tool("a".repeat(80), { type: "object" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.rule === "name.length")).toBe(true);
  });

  it("accepts a name with underscores and hyphens", () => {
    const r = validate("openai", "anthropic", tool("get_weather-v2", { type: "object" }));
    expect(r.valid).toBe(true);
  });
});

describe("validate: root type", () => {
  it("rejects a non-object root", () => {
    const r = validate("openai", "anthropic", tool("t", { type: "string" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.rule === "root.type")).toBe(true);
  });

  it("accepts an object root", () => {
    const r = validate("openai", "anthropic", tool("t", { type: "object", properties: {} }));
    expect(r.valid).toBe(true);
  });
});

describe("validate: measures the SENT schema, not the input draft", () => {
  it("a nullable union is VALID for gemini-vertex (converter rewrites to nullable:true)", () => {
    // type:["string","null"] would be rejected raw by Vertex, but the converter
    // emits nullable:true, so the sent schema is valid.
    const r = validate(
      "openai",
      "gemini-vertex",
      tool("t", { type: "object", properties: { x: { type: ["string", "null"] } } }),
    );
    expect(r.valid).toBe(true);
  });

  it("lossy-but-valid: a dropped keyword still validates (loss != rejection)", () => {
    // patternProperties is dropped (a loss) for gemini-developer, but the emitted
    // schema is still a valid object — validate cares about acceptance, not loss.
    const r = validate(
      "openai",
      "gemini-developer",
      tool("t", { type: "object", patternProperties: { "^x": { type: "string" } } }),
    );
    expect(r.valid).toBe(true);
  });
});

describe("validate: never throws", () => {
  it("handles garbage input without throwing", () => {
    expect(() => validate("openai", "anthropic", 42)).not.toThrow();
    expect(() => validate("openai", "gemini-vertex", null)).not.toThrow();
    expect(() => validate("openai", "bedrock", { nonsense: true })).not.toThrow();
  });
});
