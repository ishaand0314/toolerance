#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { cli } from "labkit-core";
import { type ConvertOptions, convert, convertAll } from "./convert.js";
import { lint } from "./lint.js";
import { type LossNote, hasLoss } from "./notes.js";
import { DIALECTS, type Dialect, isDialect } from "./schema.js";

/**
 * CLI entry. Uses the shared router from labkit-core for a consistent UX with
 * the rest of the labkit tools (--json, --help, consistent errors).
 *
 * Usage:
 *   toolerance convert --from openai --to anthropic --file tool.json
 *   toolerance convert --from openai --to gemini-vertex --file tool.json --json
 *   toolerance convert --from openai --to all --file tool.json
 *   toolerance convert --from openai --to openai --file tool.json --openai-strict
 *   cat tool.json | toolerance convert --from openai --to gemini-developer
 *   toolerance lint --dialect gemini-vertex --file openai-tool.json --from openai
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
  let from: Dialect;
  let to: Dialect | "all";
  let text: string;
  try {
    from = requireDialect(flags.from, "from");
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

  const options = optionsFromFlags(flags);

  if (to === "all") {
    return runConvertAll(from, payload, options, flags, io);
  }
  return runConvertOne(from, to, payload, options, flags, io);
}

/** Single-target conversion output + exit code. */
function runConvertOne(
  from: Dialect,
  to: Dialect,
  payload: unknown,
  options: ConvertOptions,
  flags: Record<string, string | boolean>,
  io: CliIo,
): number {
  const { output, notes } = convert(from, to, payload, options);

  if (flags.json) {
    io.writeOut(`${JSON.stringify({ output, notes }, null, 2)}\n`);
  } else {
    io.writeOut(`${JSON.stringify(output, null, 2)}\n`);
    if (notes.length > 0) {
      io.writeErr(`\n${notes.map(formatNote).join("\n")}\n`);
    }
  }

  if (flags.strict && hasLoss(notes)) {
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
): number {
  const results = convertAll(from, payload, options);

  if (flags.json) {
    const outputs: Record<string, unknown> = {};
    const notesByDialect: Record<string, LossNote[]> = {};
    for (const r of results) {
      outputs[r.dialect] = r.output;
      notesByDialect[r.dialect] = r.notes;
    }
    io.writeOut(`${JSON.stringify({ outputs, notes: notesByDialect }, null, 2)}\n`);
  } else {
    for (const r of results) {
      io.writeOut(`=== ${r.dialect} ===\n`);
      io.writeOut(`${JSON.stringify(r.output, null, 2)}\n`);
      if (r.notes.length > 0) {
        io.writeErr(`\n--- ${r.dialect} ---\n${r.notes.map(formatNote).join("\n")}\n`);
      }
    }
  }

  if (flags.strict && results.some((r) => hasLoss(r.notes))) {
    io.writeErr("\n--strict: at least one target has losses (exit 1)\n");
    return 1;
  }
  return 0;
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
      booleanFlags: ["json", "strict", "openai-strict", "openai-responses"],
    },
    argv.slice(2),
  );
}
