import { describe, expect, it } from "vitest";
import { convertTools, detectDialect, extractTools, resolveFrom } from "../src/convert.js";

/**
 * Source-dialect auto-detection and batch extraction. Detection reads the
 * envelope shape; extraction splits a multi-tool container into single tools.
 * Both are permissive: unknown shapes return null / a one-element list rather
 * than throwing.
 */

describe("detectDialect: one signal per dialect", () => {
  it("detects bedrock from a toolSpec wrapper", () => {
    const d = detectDialect({ toolSpec: { name: "t", inputSchema: { json: {} } } });
    expect(d?.dialect).toBe("bedrock");
  });

  it("detects anthropic from input_schema", () => {
    const d = detectDialect({ name: "t", input_schema: { type: "object" } });
    expect(d?.dialect).toBe("anthropic");
  });

  it("detects openai chat from a function wrapper", () => {
    const d = detectDialect({ type: "function", function: { name: "t", parameters: {} } });
    expect(d?.dialect).toBe("openai");
  });

  it("detects openai-responses from a flat name/parameters shape", () => {
    const d = detectDialect({ type: "function", name: "t", parameters: { type: "object" } });
    expect(d?.dialect).toBe("openai-responses");
  });

  it("detects gemini-developer from functionDeclarations", () => {
    const d = detectDialect({ functionDeclarations: [{ name: "t", parameters: {} }] });
    expect(d?.dialect).toBe("gemini-developer");
  });

  it("detects gemini-vertex when the schema uses ref/defs without the dollar", () => {
    const d = detectDialect({
      functionDeclarations: [
        { name: "t", parameters: { type: "object", defs: { X: { type: "string" } } } },
      ],
    });
    expect(d?.dialect).toBe("gemini-vertex");
  });

  it("detects gemini-vertex when ref/defs are nested inside a property (not just top level)", () => {
    const d = detectDialect({
      functionDeclarations: [
        {
          name: "lookup",
          parameters: {
            type: "object",
            properties: {
              wrapper: {
                type: "object",
                properties: { addr: { ref: "#/defs/Address" } },
                defs: { Address: { type: "object" } },
              },
            },
          },
        },
      ],
    });
    expect(d?.dialect).toBe("gemini-vertex");
  });

  it("detects gemini-vertex when a later declaration (not the first) carries ref/defs", () => {
    const d = detectDialect({
      functionDeclarations: [
        { name: "a" },
        { name: "b", parameters: { type: "object", defs: { X: {} } } },
      ],
    });
    expect(d?.dialect).toBe("gemini-vertex");
  });

  it("returns null for an unrecognizable payload", () => {
    expect(detectDialect({ garbage: true })).toBeNull();
    expect(detectDialect(42)).toBeNull();
    expect(detectDialect(null)).toBeNull();
  });

  it("carries a human-readable reason", () => {
    const d = detectDialect({ toolSpec: {} });
    expect(d?.reason.toLowerCase()).toContain("toolspec");
  });
});

describe("resolveFrom: auto vs explicit", () => {
  it("passes an explicit dialect through unchanged", () => {
    const r = resolveFrom("anthropic", { anything: true });
    expect(r.dialect).toBe("anthropic");
    expect(r.detection).toBeNull();
  });

  it("detects when from is auto", () => {
    const r = resolveFrom("auto", { name: "t", input_schema: {} });
    expect(r.dialect).toBe("anthropic");
    expect(r.detection).not.toBeNull();
  });

  it("throws a helpful error when auto cannot detect", () => {
    expect(() => resolveFrom("auto", { garbage: true })).toThrow(/auto-detect/i);
  });
});

describe("extractTools: split a batch container", () => {
  it("returns a bare array as-is", () => {
    const tools = extractTools([{ a: 1 }, { b: 2 }]);
    expect(tools).toHaveLength(2);
  });

  it("unwraps an OpenAI {tools:[...]} block", () => {
    const tools = extractTools({ tools: [{ a: 1 }, { b: 2 }, { c: 3 }] });
    expect(tools).toHaveLength(3);
  });

  it("splits a multi-declaration Gemini block into one payload per declaration", () => {
    const tools = extractTools({
      functionDeclarations: [{ name: "a" }, { name: "b" }],
    });
    expect(tools).toHaveLength(2);
    // Each split payload is itself a single-declaration wrapper.
    expect((tools[0] as { functionDeclarations: unknown[] }).functionDeclarations).toHaveLength(1);
  });

  it("keeps a single-declaration Gemini block whole (the wrapper is the tool)", () => {
    const tools = extractTools({ functionDeclarations: [{ name: "a" }] });
    expect(tools).toHaveLength(1);
  });

  it("unwraps a single-element {tools:[X]} to length 1 (treated as a single tool)", () => {
    const tools = extractTools({ tools: [{ name: "solo" }] });
    expect(tools).toHaveLength(1);
  });

  it("returns an empty list for an empty container (so the caller can reject it)", () => {
    expect(extractTools([])).toHaveLength(0);
    expect(extractTools({ tools: [] })).toHaveLength(0);
  });

  it("wraps a single tool as a one-element list", () => {
    const tools = extractTools({ type: "function", function: { name: "t" } });
    expect(tools).toHaveLength(1);
  });

  it("never throws on junk", () => {
    expect(() => extractTools(null)).not.toThrow();
    expect(() => extractTools(42)).not.toThrow();
    expect(extractTools(42)).toHaveLength(1);
  });
});

describe("convertTools: batch conversion keeps tools independent", () => {
  it("converts each tool and indexes the results", () => {
    const batch = [
      { type: "function", function: { name: "a", parameters: { type: "object" } } },
      { type: "function", function: { name: "b", parameters: { type: "object" } } },
    ];
    const results = convertTools("openai", "anthropic", batch);
    expect(results).toHaveLength(2);
    expect(results[0]?.index).toBe(0);
    expect(results[1]?.index).toBe(1);
    expect((results[0]?.output as { name: string }).name).toBe("a");
    expect((results[1]?.output as { name: string }).name).toBe("b");
  });

  it("does not bleed one tool's notes into another", () => {
    // First tool has a Gemini-lossy keyword; second is clean.
    const batch = [
      {
        type: "function",
        function: { name: "a", parameters: { type: "object", properties: { x: { not: {} } } } },
      },
      { type: "function", function: { name: "b", parameters: { type: "object" } } },
    ];
    const results = convertTools("openai", "gemini-developer", batch);
    expect(results[0]?.notes.some((n) => n.severity === "loss")).toBe(true);
    expect(results[1]?.notes.some((n) => n.severity === "loss")).toBe(false);
  });

  it("never throws on a batch of garbage", () => {
    expect(() => convertTools("openai", "anthropic", [42, null, "x"])).not.toThrow();
    const results = convertTools("openai", "anthropic", [42, null, "x"]);
    expect(results).toHaveLength(3);
  });
});
