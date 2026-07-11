import { describe, expect, it } from "vitest";
import { convert } from "../src/convert.js";
import type { LossNote, Severity } from "../src/notes.js";
import { GEMINI_TOGGLES } from "../src/walk.js";

/**
 * The seams table IS the spec. Every row is a place where a JSON-Schema keyword
 * is reshaped or lost between dialects, and each produces an exact note. The two
 * Gemini columns are the product: gemini-developer is narrower, gemini-vertex is
 * wider on `additionalProperties` but drops tuple `prefixItems`.
 *
 * Verified 2026-07-11 — see src/walk.ts header for the corrected rows.
 */

function find(notes: LossNote[], needle: string): LossNote | undefined {
  return notes.find((n) => n.message.toLowerCase().includes(needle.toLowerCase()));
}

function severityFor(notes: LossNote[], needle: string): Severity | undefined {
  return find(notes, needle)?.severity;
}

/** A minimal chat-tool wrapper around a parameters schema. */
function tool(parameters: unknown) {
  return { type: "function", function: { name: "t", parameters } };
}

/** The `parameters` object out of any dialect's serialized output. */
function paramsOf(output: unknown): Record<string, unknown> {
  const o = output as Record<string, unknown>;
  if (o.functionDeclarations) {
    const decls = o.functionDeclarations as Array<{ parameters: Record<string, unknown> }>;
    return decls[0]?.parameters ?? {};
  }
  if (o.function) return (o.function as { parameters: Record<string, unknown> }).parameters;
  if (o.input_schema) return o.input_schema as Record<string, unknown>;
  if (o.toolSpec) {
    return (o.toolSpec as { inputSchema: { json: Record<string, unknown> } }).inputSchema.json;
  }
  return o.parameters as Record<string, unknown>;
}

describe("seams: gemini-developer (narrow)", () => {
  it("anyOf is KEPT on gemini-developer (corrected 2026-07-11; was loss in the stale spec)", () => {
    const schema = tool({ type: "object", properties: { x: { anyOf: [{ type: "string" }] } } });
    const { output, notes } = convert("openai", "gemini-developer", schema);
    // Assert both the behavior and the toggle that drives it, so a future flip is caught.
    expect(GEMINI_TOGGLES.developerSupportsAnyOf).toBe(true);
    expect(paramsOf(output).properties).toHaveProperty("x");
    expect(
      (paramsOf(output).properties as Record<string, { anyOf?: unknown }>).x.anyOf,
    ).toBeDefined();
    expect(find(notes, "dropped `anyof`")).toBeUndefined();
  });

  it("minimum/maximum are KEPT on gemini-developer (corrected 2026-07-11)", () => {
    const schema = tool({
      type: "object",
      properties: { n: { type: "number", minimum: 0, maximum: 9 } },
    });
    const { output } = convert("openai", "gemini-developer", schema);
    const n = (paramsOf(output).properties as Record<string, Record<string, unknown>>).n;
    expect(GEMINI_TOGGLES.developerSupportsMinMax).toBe(true);
    expect(n.minimum).toBe(0);
    expect(n.maximum).toBe(9);
  });

  it("oneOf -> anyOf with a warning (exclusivity not enforced)", () => {
    const schema = tool({ type: "object", properties: { x: { oneOf: [{ type: "string" }] } } });
    const { output, notes } = convert("openai", "gemini-developer", schema);
    const x = (paramsOf(output).properties as Record<string, Record<string, unknown>>).x;
    expect(x.anyOf).toBeDefined();
    expect(x.oneOf).toBeUndefined();
    expect(severityFor(notes, "rewrote `oneof` to `anyof`")).toBe("warning");
  });

  it("allOf is dropped as a loss", () => {
    const schema = tool({ type: "object", properties: { x: { allOf: [{ type: "string" }] } } });
    const { notes } = convert("openai", "gemini-developer", schema);
    expect(severityFor(notes, "dropped `allof`")).toBe("loss");
  });

  it("not is dropped as a loss", () => {
    const schema = tool({ type: "object", properties: { x: { not: { type: "string" } } } });
    const { notes } = convert("openai", "gemini-developer", schema);
    expect(severityFor(notes, "dropped `not`")).toBe("loss");
  });

  it("additionalProperties is dropped as a warning (flaky on the function-calling path)", () => {
    const schema = tool({ type: "object", properties: {}, additionalProperties: false });
    const { output, notes } = convert("openai", "gemini-developer", schema);
    expect(GEMINI_TOGGLES.developerAdditionalPropertiesReliable).toBe(false);
    expect(paramsOf(output).additionalProperties).toBeUndefined();
    expect(severityFor(notes, "dropped `additionalproperties`")).toBe("warning");
  });

  it("patternProperties is dropped as a loss", () => {
    const schema = tool({ type: "object", patternProperties: { "^x": { type: "string" } } });
    const { notes } = convert("openai", "gemini-developer", schema);
    expect(severityFor(notes, "dropped `patternproperties`")).toBe("loss");
  });

  it("propertyNames is dropped as a loss", () => {
    const schema = tool({ type: "object", propertyNames: { pattern: "^x" } });
    const { notes } = convert("openai", "gemini-developer", schema);
    expect(severityFor(notes, "dropped `propertynames`")).toBe("loss");
  });

  it("const -> single-value enum (info)", () => {
    const schema = tool({ type: "object", properties: { k: { const: "fixed" } } });
    const { output, notes } = convert("openai", "gemini-developer", schema);
    const k = (paramsOf(output).properties as Record<string, Record<string, unknown>>).k;
    expect(k.enum).toEqual(["fixed"]);
    expect(k.const).toBeUndefined();
    expect(severityFor(notes, "rewrote `const`")).toBe("info");
  });

  it("non-temporal format is dropped (warning); temporal format is kept", () => {
    const schema = tool({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        when: { type: "string", format: "date-time" },
      },
    });
    const { output, notes } = convert("openai", "gemini-developer", schema);
    const props = paramsOf(output).properties as Record<string, Record<string, unknown>>;
    expect(props.email.format).toBeUndefined();
    expect(props.when.format).toBe("date-time");
    expect(severityFor(notes, "non-temporal `format`")).toBe("warning");
  });
});

describe("seams: gemini-vertex (wide on additionalProperties, no tuples)", () => {
  it("KEEPS additionalProperties (divergence from developer)", () => {
    const schema = tool({ type: "object", properties: {}, additionalProperties: false });
    const { output } = convert("openai", "gemini-vertex", schema);
    expect(paramsOf(output).additionalProperties).toBe(false);
  });

  it("tuple prefixItems -> homogeneous items as a loss (divergence from developer)", () => {
    const schema = tool({
      type: "object",
      properties: {
        pair: { type: "array", prefixItems: [{ type: "number" }, { type: "string" }] },
      },
    });
    const { output, notes } = convert("openai", "gemini-vertex", schema);
    const pair = (paramsOf(output).properties as Record<string, Record<string, unknown>>).pair;
    expect(pair.prefixItems).toBeUndefined();
    expect(pair.items).toEqual({ type: "number" });
    expect(severityFor(notes, "tuple `prefixitems`")).toBe("loss");
  });

  it("developer KEEPS prefixItems (divergence from vertex)", () => {
    const schema = tool({
      type: "object",
      properties: { pair: { type: "array", prefixItems: [{ type: "number" }] } },
    });
    const { output } = convert("openai", "gemini-developer", schema);
    const pair = (paramsOf(output).properties as Record<string, Record<string, unknown>>).pair;
    expect(GEMINI_TOGGLES.developerSupportsPrefixItems).toBe(true);
    expect(pair.prefixItems).toBeDefined();
  });

  it("nullable type-union -> nullable:true (both geminis)", () => {
    const schema = tool({ type: "object", properties: { x: { type: ["string", "null"] } } });
    const { output, notes } = convert("openai", "gemini-vertex", schema);
    const x = (paramsOf(output).properties as Record<string, Record<string, unknown>>).x;
    expect(x.type).toBe("string");
    expect(x.nullable).toBe(true);
    expect(severityFor(notes, "nullable: true")).toBe("info");
  });
});

describe("seams: keepers (openai / anthropic / bedrock keep everything)", () => {
  it("anthropic keeps oneOf/allOf/not/additionalProperties untouched", () => {
    const schema = tool({
      type: "object",
      properties: { x: { oneOf: [{ type: "string" }] }, y: { allOf: [{ type: "number" }] } },
      additionalProperties: false,
    });
    const { output, notes } = convert("openai", "anthropic", schema);
    const props = paramsOf(output).properties as Record<string, Record<string, unknown>>;
    expect(props.x.oneOf).toBeDefined();
    expect(props.y.allOf).toBeDefined();
    expect(paramsOf(output).additionalProperties).toBe(false);
    // The only note is the reversible input_schema rename.
    expect(notes.every((n) => n.severity === "info")).toBe(true);
  });

  it("bedrock keeps prefixItems and patternProperties untouched", () => {
    const schema = tool({
      type: "object",
      properties: { pair: { type: "array", prefixItems: [{ type: "number" }] } },
      patternProperties: { "^x": { type: "string" } },
    });
    const { output } = convert("openai", "bedrock", schema);
    const props = paramsOf(output).properties as Record<string, Record<string, unknown>>;
    expect(props.pair.prefixItems).toBeDefined();
    expect(paramsOf(output).patternProperties).toBeDefined();
  });
});

describe("seams: envelope name/description limits (flagged, never rewritten)", () => {
  it("a name with dots is flagged, not rewritten", () => {
    const schema = {
      type: "function",
      function: { name: "my.tool", parameters: { type: "object" } },
    };
    const { output, notes } = convert("openai", "anthropic", schema);
    expect((output as { name: string }).name).toBe("my.tool");
    expect(severityFor(notes, "contains dots")).toBe("warning");
  });

  it("an over-length name is flagged, not truncated", () => {
    const longName = "a".repeat(80);
    const schema = {
      type: "function",
      function: { name: longName, parameters: { type: "object" } },
    };
    const { output, notes } = convert("openai", "anthropic", schema);
    expect((output as { name: string }).name).toBe(longName);
    expect(severityFor(notes, "exceeds")).toBe("warning");
  });
});
