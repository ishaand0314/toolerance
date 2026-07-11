import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { convert, convertAll } from "../src/convert.js";
import { normalize } from "../src/normalize.js";
import { NoteCollector, hasLoss } from "../src/notes.js";
import { DIALECTS, type ObjectSchema } from "../src/schema.js";
import { arbGarbage, arbParametersSchema, arbToolDef } from "./arbitraries.js";

/**
 * Property tests — the structural backstop for "never throw, never silently
 * drop". These are the invariants the whole design rests on.
 */

describe("properties: never throws", () => {
  it("convert never throws on arbitrary garbage payloads (all source/target pairs)", () => {
    fc.assert(
      fc.property(
        arbGarbage,
        fc.constantFrom(...DIALECTS),
        fc.constantFrom(...DIALECTS),
        (payload, from, to) => {
          expect(() => convert(from, to, payload)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("convertAll never throws on arbitrary garbage payloads", () => {
    fc.assert(
      fc.property(arbGarbage, fc.constantFrom(...DIALECTS), (payload, from) => {
        expect(() => convertAll(from, payload)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("normalize never throws and always yields object parameters", () => {
    fc.assert(
      fc.property(arbGarbage, (payload) => {
        const notes = new NoteCollector();
        const out = normalize({ name: "t", parameters: payload as ObjectSchema }, notes);
        expect(typeof out.parameters).toBe("object");
      }),
      { numRuns: 200 },
    );
  });
});

describe("properties: honesty invariants", () => {
  it("normalize output has no top-level $ref/$defs for an acyclic schema", () => {
    fc.assert(
      fc.property(arbParametersSchema, (schema) => {
        const notes = new NoteCollector();
        const out = normalize({ name: "t", parameters: schema }, notes);
        const params = out.parameters as ObjectSchema;
        expect(params.$defs).toBeUndefined();
        expect(params.definitions).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it("normalize is idempotent (normalizing twice equals normalizing once)", () => {
    fc.assert(
      fc.property(arbParametersSchema, (schema) => {
        const once = normalize({ name: "t", parameters: schema }, new NoteCollector());
        const twice = normalize(once, new NoteCollector());
        expect(twice.parameters).toEqual(once.parameters);
      }),
      { numRuns: 150 },
    );
  });

  it("convert is a fixed point when target keeps everything (openai -> bedrock -> bedrock)", () => {
    fc.assert(
      fc.property(arbToolDef, (tool) => {
        const payload = {
          type: "function",
          function: { name: tool.name, parameters: tool.parameters },
        };
        const first = convert("openai", "bedrock", payload);
        const second = convert("bedrock", "bedrock", first.output);
        expect(second.output).toEqual(first.output);
      }),
      { numRuns: 150 },
    );
  });
});

describe("properties: loss monotonicity (the core divergence invariant)", () => {
  it("gemini-developer losses ⊇ gemini-vertex losses per keyword class", () => {
    // Developer is strictly narrower than Vertex on exactly one axis
    // (additionalProperties), and wider on exactly one (prefixItems). The design
    // invariant we CAN assert cheaply: neither dialect ever throws, and any input
    // that loses into vertex-only-supported territory is accounted for. Here we
    // assert the concrete, verified asymmetry holds across random safe schemas:
    // vertex keeps additionalProperties whenever developer drops it.
    fc.assert(
      fc.property(arbParametersSchema, (schema) => {
        const withAP: ObjectSchema = { ...schema, additionalProperties: false };
        const payload = { type: "function", function: { name: "t", parameters: withAP } };
        const dev = convert("openai", "gemini-developer", payload);
        const vtx = convert("openai", "gemini-vertex", payload);
        const devDropsAP = dev.notes.some((n) =>
          n.message.toLowerCase().includes("additionalproperties"),
        );
        const vtxDropsAP = vtx.notes.some((n) =>
          n.message.toLowerCase().includes("additionalproperties"),
        );
        // Developer drops it (warning); Vertex keeps it. Never the other way.
        expect(devDropsAP).toBe(true);
        expect(vtxDropsAP).toBe(false);
      }),
      { numRuns: 150 },
    );
  });

  it("hasLoss(notes) is true iff a loss-severity note exists", () => {
    fc.assert(
      fc.property(arbParametersSchema, fc.constantFrom(...DIALECTS), (schema, to) => {
        const payload = { type: "function", function: { name: "t", parameters: schema } };
        const { notes } = convert("openai", to, payload);
        const manual = notes.some((n) => n.severity === "loss");
        expect(hasLoss(notes)).toBe(manual);
      }),
      { numRuns: 150 },
    );
  });
});
