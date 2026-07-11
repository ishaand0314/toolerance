/**
 * Serializers: the canonical `ToolDef` IR -> a dialect's wire tool definition.
 *
 * One serializer per dialect. Each:
 *   1. runs `walkSchema(parameters, POLICY[dialect])` to get the dialect-shaped
 *      schema plus one note per keyword dropped/transformed;
 *   2. applies envelope-level checks common to all dialects — an invalid name
 *      (dots / over length) or an over-long description is FLAGGED, never
 *      silently rewritten or truncated;
 *   3. wraps the schema in that dialect's envelope.
 *
 * Serializers assume the IR is already normalized (ref-free, canonical
 * nullability). They return `ConvertResult<T>` and never throw.
 */

import { type ConvertResult, type LossNote, NoteCollector } from "./notes.js";
import {
  type JSONSchema,
  type ObjectSchema,
  type ToolDef,
  asArray,
  asRecord,
  asSchema,
  isObjectSchema,
} from "./schema.js";
import { POLICIES, walkSchema } from "./walk.js";

/** Options that affect serialization. */
export interface SerializeOptions {
  /** Apply OpenAI strict-mode transforms (only meaningful for the openai dialects). */
  readonly openaiStrict?: boolean;
}

type Priors = readonly LossNote[];

// ── envelope helpers (shared) ─────────────────────────────────────────────────

/** Flag a name a dialect can't represent (dots, or length > limit). Never rewrites. */
function checkName(name: string, dialect: string, maxLen: number, notes: NoteCollector): void {
  if (name.includes(".")) {
    notes.warning(`Name "${name}" contains dots, invalid for ${dialect}; left unchanged`, "name");
  }
  if (name.length > maxLen) {
    notes.warning(
      `Name "${name}" exceeds ${dialect}'s ${maxLen}-char limit (${name.length}); left unchanged`,
      "name",
    );
  }
}

/** Flag an over-long description. Never truncates. */
function checkDescription(
  description: string | undefined,
  dialect: string,
  maxLen: number | undefined,
  notes: NoteCollector,
): void {
  if (description !== undefined && maxLen !== undefined && description.length > maxLen) {
    notes.warning(
      `Description exceeds ${dialect}'s ${maxLen}-char limit (${description.length}); left untruncated`,
      "description",
    );
  }
}

/** Re-attach a cyclic `$defs` island (from normalize) and its `$ref` naming per dialect. */
function withCyclicIsland(schema: JSONSchema, tool: ToolDef, refStyle: string): JSONSchema {
  const island = asRecord(tool.extra?.["normalize.cyclesDefs"]);
  if (Object.keys(island).length === 0) return schema;
  if (!isObjectSchema(schema)) return schema;
  if (refStyle === "no-dollar") {
    return { ...renameDollarToBare(schema), defs: renameDollarToBare(island) };
  }
  return { ...schema, $defs: island };
}

/** Rename `$ref`->`ref`, `$defs`->`defs` recursively (Vertex output form). */
function renameDollarToBare<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => renameDollarToBare(v)) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = k === "$ref" ? "ref" : k === "$defs" ? "defs" : k;
      const val = k === "$ref" && typeof v === "string" ? v.replace("#/$defs/", "#/defs/") : v;
      out[key] = renameDollarToBare(val);
    }
    return out as T;
  }
  return value;
}

function result<T>(output: T, priors: Priors, notes: NoteCollector): ConvertResult<T> {
  return { output, notes: [...priors, ...notes.notes] };
}

// ── OpenAI Chat Completions ───────────────────────────────────────────────────

interface OpenAIChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: JSONSchema; strict?: boolean };
}

export function toOpenAI(
  tool: ToolDef,
  priors: Priors = [],
  options: SerializeOptions = {},
): ConvertResult<OpenAIChatTool> {
  const notes = new NoteCollector();
  const policy = POLICIES.openai;
  checkName(tool.name, "openai", policy.nameMaxLen, notes);
  checkDescription(tool.description, "openai", policy.descriptionMaxLen, notes);

  let parameters = walkSchema(tool.parameters, policy, notes, "parameters");
  parameters = withCyclicIsland(parameters, tool, policy.refStyle);
  if (options.openaiStrict) parameters = applyOpenAIStrict(parameters, notes);

  const fn: OpenAIChatTool["function"] = { name: tool.name, parameters };
  if (tool.description !== undefined) fn.description = tool.description;
  const strict = readStrict(tool, options);
  if (strict !== undefined) fn.strict = strict;

  return result({ type: "function", function: fn }, priors, notes);
}

// ── OpenAI Responses API (flat) ───────────────────────────────────────────────

interface OpenAIResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: JSONSchema;
  strict?: boolean;
}

export function toOpenAIResponses(
  tool: ToolDef,
  priors: Priors = [],
  options: SerializeOptions = {},
): ConvertResult<OpenAIResponsesTool> {
  const notes = new NoteCollector();
  const policy = POLICIES["openai-responses"];
  checkName(tool.name, "openai-responses", policy.nameMaxLen, notes);
  checkDescription(tool.description, "openai-responses", policy.descriptionMaxLen, notes);

  let parameters = walkSchema(tool.parameters, policy, notes, "parameters");
  parameters = withCyclicIsland(parameters, tool, policy.refStyle);
  if (options.openaiStrict) parameters = applyOpenAIStrict(parameters, notes);

  const out: OpenAIResponsesTool = { type: "function", name: tool.name, parameters };
  if (tool.description !== undefined) out.description = tool.description;
  const strict = readStrict(tool, options);
  if (strict !== undefined) out.strict = strict;

  return result(out, priors, notes);
}

function readStrict(tool: ToolDef, options: SerializeOptions): boolean | undefined {
  if (options.openaiStrict) return true;
  const stashed = tool.extra?.["openai.strict"];
  return typeof stashed === "boolean" ? stashed : undefined;
}

/**
 * OpenAI strict mode: every object must set `additionalProperties:false` and
 * list every property in `required`. We add the former (info) and model any
 * missing-from-required property as nullable `["T","null"]` (info) rather than
 * silently changing its meaning. Strict-unsupported constraint keywords are
 * dropped (warning). Never throws.
 */
export function applyOpenAIStrict(schema: JSONSchema, notes: NoteCollector): JSONSchema {
  return strictWalk(schema, notes, "parameters");
}

const STRICT_UNSUPPORTED = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "default",
]);

function strictWalk(schema: JSONSchema, notes: NoteCollector, path: string): JSONSchema {
  if (typeof schema !== "object" || schema === null) return schema;
  const out: ObjectSchema = {};
  const isObject = schema.type === "object" || "properties" in schema;

  for (const [key, value] of Object.entries(schema)) {
    if (STRICT_UNSUPPORTED.has(key)) {
      notes.warning(`Dropped \`${key}\` for OpenAI strict mode (unsupported)`, `${path}.${key}`);
      continue;
    }
    if (key === "properties") {
      const props = asRecord(value);
      const outProps: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(props)) {
        outProps[name] = strictWalk(asSchema(sub), notes, `${path}.properties.${name}`);
      }
      out.properties = outProps;
    } else if (key === "items") {
      out.items = strictWalk(asSchema(value), notes, `${path}.items`);
    } else {
      out[key] = value;
    }
  }

  if (isObject) {
    if (out.additionalProperties === undefined) {
      out.additionalProperties = false;
      notes.info("Added `additionalProperties:false` (required by OpenAI strict mode)", path);
    }
    // Strict requires every property listed in `required`. Model any optional
    // property as nullable rather than forcing it required.
    const props = asRecord(out.properties);
    const propNames = Object.keys(props);
    const required = new Set(
      asArray(out.required).filter((r): r is string => typeof r === "string"),
    );
    const missing = propNames.filter((n) => !required.has(n));
    if (missing.length > 0) {
      notes.warning(
        `Properties not in \`required\` under strict mode: ${missing.join(", ")}; consider modeling as nullable`,
        path,
      );
    }
  }

  return out;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JSONSchema;
}

export function toAnthropic(tool: ToolDef, priors: Priors = []): ConvertResult<AnthropicTool> {
  const notes = new NoteCollector();
  const policy = POLICIES.anthropic;
  checkName(tool.name, "anthropic", policy.nameMaxLen, notes);
  checkDescription(tool.description, "anthropic", policy.descriptionMaxLen, notes);

  let schema = walkSchema(tool.parameters, policy, notes, "parameters");
  schema = withCyclicIsland(schema, tool, policy.refStyle);
  notes.info("Renamed `parameters` to `input_schema` for Anthropic");

  const out: AnthropicTool = { name: tool.name, input_schema: schema };
  if (tool.description !== undefined) out.description = tool.description;
  return result(out, priors, notes);
}

// ── Gemini (Developer + Vertex) ───────────────────────────────────────────────

interface GeminiTool {
  functionDeclarations: Array<{ name: string; description?: string; parameters: JSONSchema }>;
}

function toGemini(
  tool: ToolDef,
  dialect: "gemini-developer" | "gemini-vertex",
  priors: Priors,
): ConvertResult<GeminiTool> {
  const notes = new NoteCollector();
  const policy = POLICIES[dialect];
  checkName(tool.name, dialect, policy.nameMaxLen, notes);
  checkDescription(tool.description, dialect, policy.descriptionMaxLen, notes);

  let parameters = walkSchema(tool.parameters, policy, notes, "parameters");
  parameters = withCyclicIsland(parameters, tool, policy.refStyle);

  const decl: GeminiTool["functionDeclarations"][number] = { name: tool.name, parameters };
  if (tool.description !== undefined) decl.description = tool.description;
  return result({ functionDeclarations: [decl] }, priors, notes);
}

export function toGeminiDeveloper(tool: ToolDef, priors: Priors = []): ConvertResult<GeminiTool> {
  return toGemini(tool, "gemini-developer", priors);
}

export function toGeminiVertex(tool: ToolDef, priors: Priors = []): ConvertResult<GeminiTool> {
  return toGemini(tool, "gemini-vertex", priors);
}

// ── Bedrock ───────────────────────────────────────────────────────────────────

interface BedrockTool {
  toolSpec: { name: string; description?: string; inputSchema: { json: JSONSchema } };
}

export function toBedrock(tool: ToolDef, priors: Priors = []): ConvertResult<BedrockTool> {
  const notes = new NoteCollector();
  const policy = POLICIES.bedrock;
  checkName(tool.name, "bedrock", policy.nameMaxLen, notes);
  checkDescription(tool.description, "bedrock", policy.descriptionMaxLen, notes);

  let schema = walkSchema(tool.parameters, policy, notes, "parameters");
  schema = withCyclicIsland(schema, tool, policy.refStyle);

  const spec: BedrockTool["toolSpec"] = { name: tool.name, inputSchema: { json: schema } };
  if (tool.description !== undefined) spec.description = tool.description;
  return result({ toolSpec: spec }, priors, notes);
}
