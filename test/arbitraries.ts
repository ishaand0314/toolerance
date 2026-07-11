import fc from "fast-check";
import type { JSONSchema, ObjectSchema, ToolDef } from "../src/schema.js";

/**
 * fast-check generators for tool definitions and JSON Schemas.
 *
 * The property tests need two kinds of input: totally arbitrary (often garbage)
 * schemas to prove the pipeline never throws, and *representable* schemas for a
 * given dialect to prove round-trip identity within that dialect's subset.
 */

/** A leaf scalar schema: string/number/integer/boolean with the odd constraint. */
const arbLeafSchema: fc.Arbitrary<ObjectSchema> = fc.oneof(
  fc.record({ type: fc.constant("string") }),
  fc.record({
    type: fc.constant("string"),
    enum: fc.array(fc.string(), { minLength: 1, maxLength: 4 }),
  }),
  fc.record({ type: fc.constant("number") }),
  fc.record({ type: fc.constant("integer") }),
  fc.record({ type: fc.constant("boolean") }),
);

/** A recursive object/array schema up to a small depth. */
const arbSchema: fc.Arbitrary<JSONSchema> = fc.letrec<{ node: JSONSchema }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    arbLeafSchema,
    fc.record({
      type: fc.constant("array"),
      items: tie("node"),
    }),
    fc.record({
      type: fc.constant("object"),
      properties: fc.dictionary(
        fc.string({ minLength: 1, maxLength: 6 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
        tie("node"),
        { maxKeys: 3 },
      ),
    }),
  ),
})).node;

/** An object-rooted parameters schema (what a tool's `parameters` must be). */
export const arbParametersSchema: fc.Arbitrary<ObjectSchema> = fc.record(
  {
    type: fc.constant("object"),
    properties: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 6 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
      arbSchema,
      { maxKeys: 4 },
    ),
    required: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }),
  },
  { requiredKeys: ["type"] },
);

/** A valid-ish canonical ToolDef with a well-formed name and object parameters. */
export const arbToolDef: fc.Arbitrary<ToolDef> = fc.record(
  {
    name: fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
    description: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
    parameters: arbParametersSchema,
  },
  { requiredKeys: ["name", "parameters"] },
);

/**
 * Totally arbitrary JSON — including numbers, nulls, arrays, and nested junk —
 * to feed the "never throws on garbage" property. Not a valid schema on purpose.
 */
export const arbGarbage: fc.Arbitrary<unknown> = fc.anything({
  maxDepth: 3,
  withNullPrototype: false,
});
