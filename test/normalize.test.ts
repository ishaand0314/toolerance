import { describe, expect, it } from "vitest";
import { normalize, resolvePointer, schemaDepth } from "../src/normalize.js";
import { NoteCollector } from "../src/notes.js";
import type { ObjectSchema, ToolDef } from "../src/schema.js";

/**
 * normalize runs once between parse and serialize: it inlines `$ref`/`$defs`,
 * resolves JSON Pointers, detects `$ref` cycles, and canonicalizes nullability.
 * Nothing here throws — every irrecoverable case becomes a note.
 */

function toolWith(parameters: unknown): ToolDef {
  return { name: "t", parameters: parameters as ObjectSchema };
}

describe("normalize: $ref / $defs inlining", () => {
  it("inlines a $defs reference into a self-contained tree", () => {
    const notes = new NoteCollector();
    const out = normalize(
      toolWith({
        type: "object",
        properties: { pet: { $ref: "#/$defs/Pet" } },
        $defs: { Pet: { type: "object", properties: { name: { type: "string" } } } },
      }),
      notes,
    );
    const params = out.parameters as ObjectSchema;
    const pet = (params.properties as Record<string, ObjectSchema>).pet;
    expect(pet.type).toBe("object");
    expect(params.$defs).toBeUndefined(); // stripped after inlining
  });

  it("inlines legacy `definitions` too, and merges when both present ($defs wins)", () => {
    const notes = new NoteCollector();
    const out = normalize(
      toolWith({
        type: "object",
        properties: { a: { $ref: "#/definitions/A" } },
        definitions: { A: { type: "string" } },
      }),
      notes,
    );
    const a = ((out.parameters as ObjectSchema).properties as Record<string, ObjectSchema>).a;
    expect(a.type).toBe("string");
  });

  it("emits an info when both $defs and definitions are present", () => {
    const notes = new NoteCollector();
    normalize(
      toolWith({
        type: "object",
        $defs: { X: { type: "string" } },
        definitions: { Y: { type: "number" } },
      }),
      notes,
    );
    expect(notes.notes.some((n) => n.message.includes("both `$defs` and `definitions`"))).toBe(
      true,
    );
  });

  it("resolves a deep JSON pointer with ~0/~1 escapes", () => {
    const root: ObjectSchema = { properties: { "a/b": { "~weird": { type: "string" } } } };
    // #/properties/a~1b/~0weird -> the string schema
    const resolved = resolvePointer("#/properties/a~1b/~0weird", root, {}) as ObjectSchema;
    expect(resolved.type).toBe("string");
  });

  it("leaves an unresolvable $ref in place with a warning (never throws)", () => {
    const notes = new NoteCollector();
    const out = normalize(
      toolWith({ type: "object", properties: { x: { $ref: "#/$defs/Missing" } } }),
      notes,
    );
    const x = ((out.parameters as ObjectSchema).properties as Record<string, ObjectSchema>).x;
    expect(x.$ref).toBe("#/$defs/Missing");
    expect(
      notes.notes.some((n) => n.severity === "warning" && n.message.includes("Unresolved $ref")),
    ).toBe(true);
  });

  it("merges sibling keywords over an inlined $ref (siblings win)", () => {
    const notes = new NoteCollector();
    const out = normalize(
      toolWith({
        type: "object",
        properties: { x: { $ref: "#/$defs/Base", description: "override" } },
        $defs: { Base: { type: "string", description: "base" } },
      }),
      notes,
    );
    const x = ((out.parameters as ObjectSchema).properties as Record<string, ObjectSchema>).x;
    expect(x.type).toBe("string");
    expect(x.description).toBe("override");
  });
});

describe("normalize: cycle detection", () => {
  it("records a recursive $ref cycle instead of inlining forever", () => {
    const notes = new NoteCollector();
    const out = normalize(
      toolWith({
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
      }),
      notes,
    );
    expect(out.extra?.["normalize.cycles"]).toBeDefined();
    // The cyclic definition is re-attached as an island for ref-keeping dialects.
    expect(out.extra?.["normalize.cyclesDefs"]).toBeDefined();
  });
});

describe("normalize: nullability + boolean schema + envelope", () => {
  it("canonicalizes nullable:true to a type union", () => {
    const notes = new NoteCollector();
    const out = normalize(
      toolWith({ type: "object", properties: { x: { type: "string", nullable: true } } }),
      notes,
    );
    const x = ((out.parameters as ObjectSchema).properties as Record<string, ObjectSchema>).x;
    expect(x.type).toEqual(["string", "null"]);
    expect(x.nullable).toBeUndefined();
  });

  it("turns boolean `true` parameters into an empty object schema", () => {
    const notes = new NoteCollector();
    const out = normalize({ name: "t", parameters: true }, notes);
    expect(out.parameters).toEqual({ type: "object" });
  });

  it("warns on an empty tool name but never invents one", () => {
    const notes = new NoteCollector();
    const out = normalize({ name: "", parameters: { type: "object" } }, notes);
    expect(out.name).toBe("");
    expect(notes.notes.some((n) => n.message.includes("no name"))).toBe(true);
  });
});

describe("normalize: schemaDepth", () => {
  it("counts an object with scalar props as depth 2 (object + leaf)", () => {
    expect(schemaDepth({ type: "object", properties: { x: { type: "string" } } })).toBe(2);
  });

  it("counts a bare leaf schema as depth 1", () => {
    expect(schemaDepth({ type: "string" })).toBe(1);
  });
});
