/**
 * Parsers: a dialect's wire tool definition -> the canonical `ToolDef` IR.
 *
 * One parser per dialect. Adding a dialect is one function here (and one in
 * serialize.ts) — never a pairwise converter.
 *
 * Parsers do ENVELOPE unwrapping only: they lift the name, description, and the
 * JSON-Schema `parameters` out of each dialect's wrapper, record `info` notes
 * for lossless-but-notable normalizations (an `input_schema` rename, a stashed
 * `strict` flag), and stash unrepresentable envelope fields into
 * `tool.extra["<dialect>.<field>"]` for round-trip. They do NOT judge schema
 * keywords — that is the walker's job, run per target in serialize. They are
 * permissive readers and never throw.
 */

import { NoteCollector } from "./notes.js";
import { type JSONSchema, type ToolDef, asArray, asRecord, asSchema, asString } from "./schema.js";

/** A parsed tool plus the notes the parser emitted. */
export interface ParseResult {
  tool: ToolDef;
  collector: NoteCollector;
}

// ── OpenAI Chat Completions ───────────────────────────────────────────────────
//
// Shape: { type: "function", function: { name, description?, parameters? } }
// Also auto-detects the flat Responses shape and delegates to it.

export function parseOpenAI(payload: unknown): ParseResult {
  const notes = new NoteCollector();
  const root = asRecord(payload);

  // Auto-detect: a payload with top-level `name` and no `function` wrapper is
  // actually the Responses shape.
  if (detectOpenAIShape(root) === "responses") {
    const result = parseOpenAIResponses(payload);
    result.collector.info("Input looks like the OpenAI Responses (flat) shape; parsed as such");
    return result;
  }

  const fn = asRecord(root.function);
  const tool: ToolDef = {
    name: asString(fn.name),
    parameters: asSchema(fn.parameters),
  };
  const description = asString(fn.description);
  if (description.length > 0) tool.description = description;

  // `strict` is an OpenAI-only envelope flag; stash it for round-trip.
  const extra: Record<string, unknown> = {};
  if (fn.strict !== undefined) extra["openai.strict"] = fn.strict;
  if (root.strict !== undefined) extra["openai.strict"] = root.strict;
  if (Object.keys(extra).length > 0) tool.extra = extra;

  return { tool, collector: notes };
}

/** "chat" if it has a `function` wrapper, "responses" if it's flat. */
export function detectOpenAIShape(root: Record<string, unknown>): "chat" | "responses" {
  if ("function" in root) return "chat";
  if ("name" in root || "parameters" in root) return "responses";
  return "chat";
}

// ── OpenAI Responses API ──────────────────────────────────────────────────────
//
// Shape: { type: "function", name, description?, parameters? } (flattened)

export function parseOpenAIResponses(payload: unknown): ParseResult {
  const notes = new NoteCollector();
  const root = asRecord(payload);

  const tool: ToolDef = {
    name: asString(root.name),
    parameters: asSchema(root.parameters),
  };
  const description = asString(root.description);
  if (description.length > 0) tool.description = description;
  if (root.strict !== undefined) tool.extra = { "openai.strict": root.strict };

  return { tool, collector: notes };
}

// ── Anthropic ─────────────────────────────────────────────────────────────────
//
// Shape: { name, description?, input_schema }

export function parseAnthropic(payload: unknown): ParseResult {
  const notes = new NoteCollector();
  const root = asRecord(payload);

  const tool: ToolDef = {
    name: asString(root.name),
    parameters: asSchema(root.input_schema),
  };
  const description = asString(root.description);
  if (description.length > 0) tool.description = description;
  if ("input_schema" in root) {
    notes.info("Renamed Anthropic `input_schema` to `parameters`");
  }

  return { tool, collector: notes };
}

// ── Gemini (Developer + Vertex share a wrapper) ───────────────────────────────
//
// Shape: { functionDeclarations: [ { name, description?, parameters } ] }
// Two parsers so the source dialect identity survives parse (needed for lint and
// round-trip), even though the wire wrapper is identical.

function parseGeminiWrapper(payload: unknown, dialectLabel: string): ParseResult {
  const notes = new NoteCollector();
  const root = asRecord(payload);
  const decls = asArray(root.functionDeclarations);

  // A bare functionDeclaration (no wrapper) is also accepted.
  const firstDecl = decls.length > 0 ? asRecord(decls[0]) : root;
  if (decls.length > 1) {
    notes.warning(
      `Gemini payload has ${decls.length} functionDeclarations; parsed the first (rest stashed in extra)`,
    );
  }

  const params: JSONSchema =
    firstDecl.parameters !== undefined
      ? asSchema(firstDecl.parameters)
      : asSchema(firstDecl.parametersJsonSchema);

  const tool: ToolDef = {
    name: asString(firstDecl.name),
    parameters: params,
  };
  const description = asString(firstDecl.description);
  if (description.length > 0) tool.description = description;

  const extra: Record<string, unknown> = {};
  if (decls.length > 1) extra[`${dialectLabel}.extraDeclarations`] = decls.slice(1);
  if (Object.keys(extra).length > 0) tool.extra = extra;

  return { tool, collector: notes };
}

export function parseGeminiDeveloper(payload: unknown): ParseResult {
  return parseGeminiWrapper(payload, "gemini-developer");
}

export function parseGeminiVertex(payload: unknown): ParseResult {
  const result = parseGeminiWrapper(payload, "gemini-vertex");
  // Vertex uses ref/defs (no $). Rewrite to the canonical $ref/$defs so normalize
  // can inline them, then note it (reversible).
  const rewritten = rewriteVertexRefsToDollar(result.tool.parameters);
  if (rewritten.changed) {
    result.tool.parameters = rewritten.schema;
    result.collector.info(
      "Rewrote Vertex `ref`/`defs` to canonical `$ref`/`$defs` for normalization",
    );
  }
  return result;
}

/** Recursively rename Vertex `ref`->`$ref` and `defs`->`$defs` (and pointers). */
function rewriteVertexRefsToDollar(schema: JSONSchema): { schema: JSONSchema; changed: boolean } {
  if (typeof schema !== "object" || schema === null) return { schema, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    let outKey = key;
    let outVal: unknown = value;
    if (key === "ref" && typeof value === "string") {
      outKey = "$ref";
      outVal = value.replace("#/defs/", "#/$defs/");
      changed = true;
    } else if (key === "defs") {
      outKey = "$defs";
      changed = true;
    }
    if (typeof outVal === "object" && outVal !== null) {
      if (Array.isArray(outVal)) {
        outVal = outVal.map((v) => {
          const r = rewriteVertexRefsToDollar(asSchema(v));
          if (r.changed) changed = true;
          return r.schema;
        });
      } else {
        const r = rewriteVertexRefsToDollar(outVal as JSONSchema);
        if (r.changed) changed = true;
        outVal = r.schema;
      }
    }
    out[outKey] = outVal;
  }
  return { schema: out, changed };
}

// ── Bedrock (AWS Bedrock Converse toolSpec) ───────────────────────────────────
//
// Shape: { toolSpec: { name, description?, inputSchema: { json: {...} } } }

export function parseBedrock(payload: unknown): ParseResult {
  const notes = new NoteCollector();
  const root = asRecord(payload);
  const spec = asRecord(root.toolSpec !== undefined ? root.toolSpec : root);
  const inputSchema = asRecord(spec.inputSchema);

  const tool: ToolDef = {
    name: asString(spec.name),
    parameters: asSchema(inputSchema.json),
  };
  const description = asString(spec.description);
  if (description.length > 0) tool.description = description;
  if ("toolSpec" in root) {
    notes.info("Unwrapped Bedrock `toolSpec.inputSchema.json` to `parameters`");
  }

  return { tool, collector: notes };
}
