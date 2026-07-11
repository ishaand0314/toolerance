#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { cli } from "labkit-core";
import {
  type BatchAllItemResult,
  type BatchItemResult,
  type ConvertOptions,
  convertAllTools,
  convertTools,
  extractTools,
  resolveFrom,
} from "./convert.js";
import { lint } from "./lint.js";
import { type LossNote, hasLoss } from "./notes.js";
import { DIALECTS, type Dialect, isDialect } from "./schema.js";

/**
 * CLI entry. Uses the shared router from labkit-core for a consistent UX with
 * the rest of the labkit tools (--json, --help, consistent errors).
 *
 * Usage:
 *   toolerance convert --from openai --to anthropic --file tool.json
 *   toolerance convert --from auto --to anthropic --file tool.json   (detect source)
 *   toolerance convert --from openai --to gemini-vertex --file tool.json --json
 *   toolerance convert --from openai --to all --file tools.json      (batch: array or {tools:[…]})
 *   toolerance convert --from openai --to openai --file tool.json --openai-strict
 *   cat tool.json | toolerance convert --from openai --to gemini-developer
 *   toolerance lint --dialect gemini-vertex --file openai-tool.json --from openai
 *
 * `--from auto` detects the source dialect from the payload shape. Passing an
 * array of tools, or an OpenAI `{tools:[…]}` block, converts every tool in the
 * batch; a single tool keeps the original flat output shape.
 *
 * Default output: the converted payload as pretty JSON on stdout; the notes on
 * stderr (so a redirect captures a clean payload). A zero-note conversion prints
 * nothing to stderr. --json emits { output, notes } together on stdout.
 * --strict exits 1 if any note is a "loss".
 */

/** Thrown for bad user input; caught to print a one-line error. */
class UsageError extends Error {}

/** Injected I/O so the commands are testable without touching the real process. */
export interface CliIo {
  readFile(path: string): string;
  readStdin(): string;
  stdinIsTty: boolean;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

const dialectList = DIALECTS.join(", ");

/** Resolve a `--from`/`--dialect` value to a Dialect, or throw a UsageError. */
function requireDialect(value: string | boolean | undefined, flag: string): Dialect {
  if (typeof value !== "string") {
    throw new UsageError(`--${flag} is required, one of: ${dialectList}`);
  }
  if (!isDialect(value)) {
    throw new UsageError(`--${flag} must be one of: ${dialectList} (got "${value}")`);
  }
  return value;
}

/** Resolve `--to`, which additionally accepts the literal `all`. */
function requireTarget(value: string | boolean | undefined): Dialect | "all" {
  if (value === "all") return "all";
  return requireDialect(value, "to");
}

/** Resolve `--from`, which additionally accepts the literal `auto` (detect it). */
function requireFrom(value: string | boolean | undefined): Dialect | "auto" {
  if (value === "auto") return "auto";
  return requireDialect(value, "from");
}

function readPayloadText(flags: Record<string, string | boolean>, io: CliIo): string {
  const file = flags.file;
  if (file !== undefined) {
    if (typeof file !== "string") {
      throw new UsageError("--file requires a filename, e.g. --file tool.json");
    }
    try {
      return io.readFile(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UsageError(`Cannot read --file "${file}": ${msg}`);
    }
  }
  if (!io.stdinIsTty) {
    return io.readStdin();
  }
  throw new UsageError("Provide input: --file tool.json, or pipe a tool definition on stdin");
}

function formatNote(note: LossNote): string {
  const badge = note.severity.toUpperCase().padEnd(7);
  const where = note.path ? `  (${note.path})` : "";
  return `${badge} ${note.message}${where}`;
}

/** Build the ConvertOptions from parsed flags. */
function optionsFromFlags(flags: Record<string, string | boolean>): ConvertOptions {
  return { openaiStrict: flags["openai-strict"] === true };
}

/**
 * The `convert` command body, exposed for testing. Returns the intended exit
 * code (0 ok, 1 on usage error / invalid JSON / a "loss" under --strict).
 */
export function runConvertCommand(ctx: cli.CommandContext, io: CliIo): number {
  const { flags } = ctx;
  let fromFlag: Dialect | "auto";
  let to: Dialect | "all";
  let text: string;
  try {
    fromFlag = requireFrom(flags.from);
    to = requireTarget(flags.to);
    text = readPayloadText(flags, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.writeErr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.writeErr(`Input is not valid JSON: ${msg}\n`);
    return 1;
  }

  // Resolve `--from auto` against the actual payload. A batch detects from the
  // first tool so every tool in the batch is read as the same source dialect.
  let from: Dialect;
  try {
    const probe = extractTools(payload)[0];
    const { dialect, detection } = resolveFrom(fromFlag, probe);
    from = dialect;
    if (detection !== null) {
      io.writeErr(`Detected source dialect: ${detection.dialect} (${detection.reason})\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.writeErr(`${msg}\n`);
    return 1;
  }

  const options = optionsFromFlags(flags);
  const tools = extractTools(payload);
  // A container that holds no tools is a usage error, not a conversion of one
  // empty tool. Report it plainly rather than emitting a fabricated `{}`.
  if (tools.length === 0) {
    io.writeErr("Input contains no tools (empty array or empty `tools`)\n");
    return 1;
  }
  const isBatch = tools.length > 1;

  // Defense-in-depth: the library is bounded and should not throw, but a bug
  // there must still exit 1 cleanly rather than crash the process with an
  // uncaught exception. This is the only place a library throw could escape.
  try {
    if (to === "all") {
      return runConvertAll(from, payload, options, flags, io, isBatch);
    }
    return runConvertOne(from, to, payload, options, flags, io, isBatch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.writeErr(`Conversion failed unexpectedly: ${msg}\n`);
    return 1;
  }
}

/** Single-target conversion output + exit code. Handles single tools and batches. */
function runConvertOne(
  from: Dialect,
  to: Dialect,
  payload: unknown,
  options: ConvertOptions,
  flags: Record<string, string | boolean>,
  io: CliIo,
  isBatch: boolean,
): number {
  const items = convertTools(from, to, payload, options);

  if (flags.json) {
    // Batch -> array of {index, output, notes}; single -> the flat {output, notes}
    // shape (backward-compatible with pre-batch callers and tests).
    if (isBatch) {
      io.writeOut(`${JSON.stringify({ tools: items }, null, 2)}\n`);
    } else {
      const only = firstItem(items);
      io.writeOut(`${JSON.stringify({ output: only.output, notes: only.notes }, null, 2)}\n`);
    }
  } else if (isBatch) {
    for (const item of items) {
      io.writeOut(`=== tool[${item.index}] ===\n`);
      io.writeOut(`${JSON.stringify(item.output, null, 2)}\n`);
      if (item.notes.length > 0) {
        io.writeErr(`\n--- tool[${item.index}] ---\n${item.notes.map(formatNote).join("\n")}\n`);
      }
    }
  } else {
    const only = firstItem(items);
    io.writeOut(`${JSON.stringify(only.output, null, 2)}\n`);
    if (only.notes.length > 0) {
      io.writeErr(`\n${only.notes.map(formatNote).join("\n")}\n`);
    }
  }

  if (flags.strict && items.some((i) => hasLoss(i.notes))) {
    io.writeErr("\n--strict: conversion has losses (exit 1)\n");
    return 1;
  }
  return 0;
}

/** `--to all` matrix output + exit code (strict fails if ANY target loses). */
function runConvertAll(
  from: Dialect,
  payload: unknown,
  options: ConvertOptions,
  flags: Record<string, string | boolean>,
  io: CliIo,
  isBatch: boolean,
): number {
  const items = convertAllTools(from, payload, options);

  if (flags.json) {
    if (isBatch) {
      const tools = items.map((item) => ({
        index: item.index,
        outputs: byDialect(item.results, (r) => r.output),
        notes: byDialect(item.results, (r) => r.notes),
      }));
      io.writeOut(`${JSON.stringify({ tools }, null, 2)}\n`);
    } else {
      const results = firstAllItem(items).results;
      io.writeOut(
        `${JSON.stringify(
          {
            outputs: byDialect(results, (r) => r.output),
            notes: byDialect(results, (r) => r.notes),
          },
          null,
          2,
        )}\n`,
      );
    }
  } else {
    for (const item of items) {
      const prefix = isBatch ? `tool[${item.index}] ` : "";
      for (const r of item.results) {
        io.writeOut(`=== ${prefix}${r.dialect} ===\n`);
        io.writeOut(`${JSON.stringify(r.output, null, 2)}\n`);
        if (r.notes.length > 0) {
          io.writeErr(`\n--- ${prefix}${r.dialect} ---\n${r.notes.map(formatNote).join("\n")}\n`);
        }
      }
    }
  }

  const anyLoss = items.some((item) => item.results.some((r) => hasLoss(r.notes)));
  if (flags.strict && anyLoss) {
    io.writeErr("\n--strict: at least one target has losses (exit 1)\n");
    return 1;
  }
  return 0;
}

/** Group per-dialect results into a `{ [dialect]: value }` record. */
function byDialect<T>(
  results: { dialect: Dialect; output: unknown; notes: LossNote[] }[],
  pick: (r: { dialect: Dialect; output: unknown; notes: LossNote[] }) => T,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const r of results) out[r.dialect] = pick(r);
  return out;
}

/** A batch always has at least one item (extractTools never returns empty). */
function firstItem(items: BatchItemResult[]): BatchItemResult {
  const first = items[0];
  if (first === undefined) return { index: 0, output: {}, notes: [] };
  return first;
}

function firstAllItem(items: BatchAllItemResult[]): BatchAllItemResult {
  const first = items[0];
  if (first === undefined) return { index: 0, results: [] };
  return first;
}

/**
 * The `lint` command body, exposed for testing. Reports what a chosen dialect
 * cannot represent about a tool, without emitting a converted schema.
 */
export function runLintCommand(ctx: cli.CommandContext, io: CliIo): number {
  const { flags } = ctx;
  let from: Dialect;
  let against: Dialect;
  let text: string;
  try {
    // `--from` defaults to the linted dialect when omitted (lint against itself).
    against = requireDialect(flags.dialect, "dialect");
    from = flags.from !== undefined ? requireDialect(flags.from, "from") : against;
    text = readPayloadText(flags, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.writeErr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.writeErr(`Input is not valid JSON: ${msg}\n`);
    return 1;
  }

  const { output, notes } = lint(from, against, payload);

  if (flags.json) {
    io.writeOut(`${JSON.stringify({ tool: output, notes }, null, 2)}\n`);
  } else {
    io.writeOut(`${JSON.stringify(output, null, 2)}\n`);
    if (notes.length > 0) {
      io.writeErr(`\n${notes.map(formatNote).join("\n")}\n`);
    } else {
      io.writeErr(`\nNo issues: ${against} can represent this tool as-is.\n`);
    }
  }

  if (flags.strict && hasLoss(notes)) {
    io.writeErr("\n--strict: tool has losses against this dialect (exit 1)\n");
    return 1;
  }
  return 0;
}

const realIo: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  readStdin: () => readFileSync(0, "utf8"),
  stdinIsTty: process.stdin.isTTY === true,
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
};

const convertCommand: cli.Command = {
  name: "convert",
  summary: "Convert a tool definition between provider dialects and report what changed",
  run(ctx) {
    const code = runConvertCommand(ctx, realIo);
    if (code !== 0) process.exitCode = code;
  },
};

const lintCommand: cli.Command = {
  name: "lint",
  summary: "Report what a dialect cannot represent about a tool, without converting it",
  run(ctx) {
    const code = runLintCommand(ctx, realIo);
    if (code !== 0) process.exitCode = code;
  },
};

/** Only run the CLI when invoked directly, not when imported by tests. */
function isMain(): boolean {
  const entry = argv[1];
  return entry !== undefined && entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  await cli.run(
    {
      name: "toolerance",
      description: `Cross-lab tool-schema converter (${dialectList}, or "all")`,
      commands: [convertCommand, lintCommand],
      booleanFlags: ["json", "strict", "openai-strict"],
    },
    argv.slice(2),
  );
}
