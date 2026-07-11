# toolerance — working notes for agents

`toolerance` converts one canonical tool/function schema into every provider dialect
(OpenAI Chat + Responses, Anthropic, Gemini Developer + Vertex, AWS Bedrock) and
reports what each target cannot represent.

## Two invariants (do not break these)

1. **Never throw.** Any input, including garbage, must produce a best-effort result
   plus notes. The pipeline (`convert`, `convertAll`, `normalize`, `lint`) must not
   throw. Only the CLI layer may throw `UsageError`. Read input through the
   permissive readers in `src/schema.ts` (`asRecord`, `asArray`, `asString`,
   `asSchema`), never by assuming a shape.
2. **Never silently drop.** Every keyword that is removed, renamed, or reshaped emits
   exactly one note with a `path`. Reversible change is `info`, weakened-but-kept is
   `warning`, unrepresentable-and-removed is `loss`.

## Where things live

- `src/schema.ts` — the IR (JSON Schema) types and permissive readers.
- `src/normalize.ts` — the shared pass: `$ref`/`$defs`/`definitions` inlining, deep
  JSON pointers, cycle detection, nullability union, boolean schemas, root defaulting.
- `src/walk.ts` — the per-dialect policy tables and the single shared walker. The two
  Gemini policies sit adjacent so their divergence is readable. Every stale-risk fact
  is a named boolean at the top, mirrored in `GEMINI_TOGGLES` for tests.
- `src/parse.ts` / `src/serialize.ts` — envelope unwrap / rewrap per dialect.
- `src/convert.ts` / `src/lint.ts` / `src/cli.ts` / `src/index.ts` — composition,
  the lint command, the CLI, the public API.

## Commands

```bash
pnpm install
pnpm build      # tsc --build
pnpm test       # vitest run
pnpm lint       # biome check .
pnpm lint:fix   # biome check --write .
```

## When you touch the dialect facts

`src/walk.ts` carries a verification date. Provider schema support changes, so before
trusting a Gemini row, re-check it against current provider docs. The `seam-verifier`
agent does this. If you change a rule, move the date, flip the matching toggle, and
update the matching test in `test/seams.test.ts` and the seams table in `README.md`.

## Docs style

User-facing docs (README, package description, any GitHub text) are written in plain
prose: no em dashes, no "not X but Y" framing, no marketing filler.
