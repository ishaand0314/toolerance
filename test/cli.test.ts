import { describe, expect, it } from "vitest";
import type { CliIo } from "../src/cli.js";
import { runConvertCommand, runLintCommand } from "../src/cli.js";

/**
 * CLI tests drive the command bodies with an injected `CliIo`, so nothing
 * touches the real filesystem or process. Each asserts the exit code and the
 * split of payload (stdout) vs notes (stderr).
 */

/** A fake IO capturing writes; stdin fed from a fixed string, no TTY. */
function fakeIo(overrides: Partial<CliIo> = {}): CliIo & { out: string; err: string } {
  const state = { out: "", err: "" };
  return {
    out: "",
    err: "",
    readFile: () => {
      throw new Error("no file");
    },
    readStdin: () => "",
    stdinIsTty: false,
    writeOut(text: string) {
      state.out += text;
      this.out += text;
    },
    writeErr(text: string) {
      state.err += text;
      this.err += text;
    },
    ...overrides,
  };
}

/** Build a CommandContext with the given flags. */
function ctx(flags: Record<string, string | boolean>) {
  return { args: [], flags };
}

const OPENAI_TOOL = JSON.stringify({
  type: "function",
  function: {
    name: "search",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
});

describe("cli: convert", () => {
  it("stdin -> clean payload on stdout, exit 0", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runConvertCommand(ctx({ from: "openai", to: "anthropic" }), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed.input_schema).toBeDefined();
  });

  it("--json emits { output, notes } together on stdout", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runConvertCommand(ctx({ from: "openai", to: "anthropic", json: true }), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed).toHaveProperty("output");
    expect(parsed).toHaveProperty("notes");
  });

  it("--strict exits 1 when the conversion has a loss", () => {
    const lossy = JSON.stringify({
      type: "function",
      function: {
        name: "t",
        parameters: {
          type: "object",
          properties: { p: { type: "array", prefixItems: [{ type: "number" }] } },
        },
      },
    });
    const io = fakeIo({ readStdin: () => lossy });
    const code = runConvertCommand(ctx({ from: "openai", to: "gemini-vertex", strict: true }), io);
    expect(code).toBe(1);
    expect(io.err).toContain("--strict");
  });

  it("--strict exits 0 when there is no loss", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runConvertCommand(ctx({ from: "openai", to: "anthropic", strict: true }), io);
    expect(code).toBe(0);
  });

  it("unknown --to exits 1 with a usage error", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runConvertCommand(ctx({ from: "openai", to: "nope" }), io);
    expect(code).toBe(1);
    expect(io.err.toLowerCase()).toContain("must be one of");
  });

  it("--to all emits every dialect as a === section ===", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runConvertCommand(ctx({ from: "openai", to: "all" }), io);
    expect(code).toBe(0);
    expect(io.out).toContain("=== openai ===");
    expect(io.out).toContain("=== gemini-developer ===");
    expect(io.out).toContain("=== gemini-vertex ===");
    expect(io.out).toContain("=== bedrock ===");
  });

  it("--to all --json is keyed by dialect", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runConvertCommand(ctx({ from: "openai", to: "all", json: true }), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(Object.keys(parsed.outputs)).toContain("gemini-vertex");
    expect(Object.keys(parsed.notes)).toContain("gemini-vertex");
  });

  it("--file read error exits 1", () => {
    const io = fakeIo({
      stdinIsTty: true,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    const code = runConvertCommand(
      ctx({ from: "openai", to: "anthropic", file: "missing.json" }),
      io,
    );
    expect(code).toBe(1);
    expect(io.err).toContain("Cannot read --file");
  });

  it("invalid JSON exits 1", () => {
    const io = fakeIo({ readStdin: () => "{ not json" });
    const code = runConvertCommand(ctx({ from: "openai", to: "anthropic" }), io);
    expect(code).toBe(1);
    expect(io.err).toContain("not valid JSON");
  });

  it("--openai-strict adds additionalProperties:false", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runConvertCommand(
      ctx({ from: "openai", to: "openai", "openai-strict": true }),
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed.function.parameters.additionalProperties).toBe(false);
    expect(parsed.function.strict).toBe(true);
  });
});

describe("cli: lint", () => {
  it("lints an openai tool against gemini-vertex and reports the prefixItems loss", () => {
    const lossy = JSON.stringify({
      type: "function",
      function: {
        name: "t",
        parameters: {
          type: "object",
          properties: { p: { type: "array", prefixItems: [{ type: "number" }] } },
        },
      },
    });
    const io = fakeIo({ readStdin: () => lossy });
    const code = runLintCommand(ctx({ dialect: "gemini-vertex", from: "openai" }), io);
    expect(code).toBe(0);
    expect(io.err.toLowerCase()).toContain("prefixitems");
  });

  it("reports 'no issues' when the dialect can represent the tool", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runLintCommand(ctx({ dialect: "gemini-vertex", from: "openai" }), io);
    expect(code).toBe(0);
    expect(io.err.toLowerCase()).toContain("no issues");
  });

  it("missing --dialect exits 1", () => {
    const io = fakeIo({ readStdin: () => OPENAI_TOOL });
    const code = runLintCommand(ctx({ from: "openai" }), io);
    expect(code).toBe(1);
  });
});
