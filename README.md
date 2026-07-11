# toolerance

Write one tool schema. Ship it to every LLM. See exactly what each provider drops.

`toolerance` takes one canonical tool definition and produces the function-calling
schema each provider expects: OpenAI (Chat and Responses), Anthropic, Gemini
(Developer and Vertex), and AWS Bedrock. For every conversion it reports what the
target cannot represent, so you find out at build time instead of at call time.

The hard part of moving a tool schema across providers is that the two Gemini API
surfaces accept different subsets of JSON Schema and reject the rest when you call
them. `toolerance` makes those differences visible. It does not throw, it does not
drop a keyword without telling you, and it tags every change with a severity.

```
$ echo '{"type":"function","function":{"name":"get_weather",
    "description":"Get the current weather for a city.",
    "parameters":{"type":"object",
      "properties":{"city":{"type":"string"},"units":{"enum":["c","f"]}},
      "required":["city"]}}}' \
  | toolerance convert --from openai --to anthropic
```
```json
{
  "name": "get_weather",
  "input_schema": {
    "type": "object",
    "properties": {
      "city": { "type": "string" },
      "units": { "type": "string", "enum": ["c", "f"] }
    },
    "required": ["city"]
  },
  "description": "Get the current weather for a city."
}
```
```
INFO    Renamed `parameters` to `input_schema` for Anthropic
```

The converted schema goes to stdout and the notes go to stderr. You can pipe the
output straight into your app and still read the report.

## Install

```bash
npm install -g toolerance      # or: pnpm add -g toolerance
```

Run it without installing:

```bash
npx toolerance convert --from openai --to anthropic --file tool.json
```

Node.js 20 or newer is required.

Use it as a library:

```bash
npm install toolerance
```
```ts
import { convert, convertAll, lint, DIALECTS } from "toolerance";

const { output, notes } = convert("openai", "gemini-vertex", myTool);
```

## The six dialects

| Dialect | Envelope it emits |
| --- | --- |
| `openai` | `{ type: "function", function: { name, description, parameters } }` (Chat Completions) |
| `openai-responses` | flat `{ type: "function", name, description, parameters }` (Responses API) |
| `anthropic` | `{ name, description, input_schema }` |
| `gemini-developer` | `{ functionDeclarations: [{ name, description, parameters }] }` (Google AI / Developer API) |
| `gemini-vertex` | same wrapper, Vertex-flavored schema (`ref`/`defs` without `$`, `nullable` flags) |
| `bedrock` | `{ toolSpec: { name, description, inputSchema: { json } } }` |

Any of these works as a `--from` or a `--to`. `--from` says how to unwrap the input
envelope. `--to` says which one to emit.

## Commands

### `convert`: one schema in, one or all out

```bash
# one target
toolerance convert --from openai --to gemini-vertex --file tool.json

# read from stdin
cat tool.json | toolerance convert --from anthropic --to bedrock

# machine-readable: { "output": ..., "notes": [...] }
toolerance convert --from openai --to gemini-developer --file tool.json --json

# every dialect at once
toolerance convert --from openai --to all --file tool.json
```

`--to all` prints each dialect in a labeled section (`=== gemini-vertex ===`) with
its notes underneath. Add `--json` to get `{ outputs, notes }` keyed by dialect.

### `--from auto`: detect the source dialect

If you do not want to name the source, pass `--from auto` and `toolerance` reads
the envelope shape to figure it out. It reports what it detected on stderr:

```bash
echo '{"name":"get_weather","input_schema":{"type":"object"}}' \
  | toolerance convert --from auto --to openai
```
```
Detected source dialect: anthropic (has an `input_schema` (Anthropic))
```

If the shape is unrecognizable, it exits 1 and asks you to pass an explicit
`--from`.

### Batch: convert many tools at once

A real toolset is more than one tool. Pass a JSON array of tool definitions, or an
OpenAI `{ "tools": [ ... ] }` block, and every tool converts in one run. Each tool
is converted independently, so one tool's notes never leak into another's.

```bash
toolerance convert --from openai --to anthropic --file my-tools.json
```
```
=== tool[0] ===
{ "name": "get_weather", "input_schema": { ... } }
=== tool[1] ===
{ "name": "search", "input_schema": { ... } }
```

With `--json`, a batch returns `{ "tools": [ { index, output, notes }, ... ] }`. A
single tool keeps the flat `{ output, notes }` shape. `--strict` exits 1 if any
tool in the batch has a loss.

### `lint`: check a schema against a dialect

`lint` normalizes your tool and walks it through a target dialect's rules, showing
every note that dialect would produce. It does not emit a converted schema for a
different provider. Use it to answer a question like "will Gemini Vertex accept
this?"

```bash
toolerance lint --dialect gemini-vertex --from openai --file search.json
```
```
WARNING Rewrote `oneOf` to `anyOf` (Gemini has no `oneOf`; exclusivity is not enforced)  (parameters.properties.mode.oneOf)
INFO    Rewrote `const` to a single-value `enum` (Gemini has no `const`)  (parameters.properties.mode.anyOf[0].const)
INFO    Rewrote `const` to a single-value `enum` (Gemini has no `const`)  (parameters.properties.mode.anyOf[1].const)
LOSS    Dropped tuple `prefixItems` for gemini-vertex (no tuple support); use homogeneous `items`  (parameters.properties.range.prefixItems)
INFO    Converted type union ["T","null"] to `nullable: true`  (parameters.properties.limit)
```

`--from` defaults to `--dialect` when omitted, which lints the schema as its own
dialect.

### `validate`: will the provider reject this at call time?

`validate` answers a different question from `lint`. `lint` tells you what a
dialect would reshape; `validate` tells you whether the provider's API would
refuse the tool with a 400. It checks the hard rules: the name must match the
provider's regex and length limit, the root must be `type:"object"`, and nesting
must stay within the provider's depth limit.

It runs the real conversion first, so it judges the schema that would actually be
sent. A `["string","null"]` union validates clean for Gemini, because the
converter rewrites it to `nullable:true` before sending.

```bash
toolerance validate --dialect anthropic --from openai --file tool.json
```
```
INVALID: anthropic would reject this tool.
  [name.pattern] Tool name "my.tool" has characters anthropic rejects (allowed: letters, digits, underscore, hyphen)  (name)
```

Exit code is 0 when valid, 1 when invalid, so you can gate a deploy on it. Add
`--json` for `{ valid, errors, dialect }`.

The three checks, side by side:

| Command | Question it answers |
| --- | --- |
| `lint` | What would this dialect reshape or drop? (advisory) |
| `convert --strict` | Does converting lose any information? (gates on `LOSS`) |
| `validate` | Would the provider reject this tool at call time? (gates on rejection) |

### Flags

| Flag | Effect |
| --- | --- |
| `--from <dialect>` or `--from auto` | how to unwrap the input, or `auto` to detect it (required for `convert`) |
| `--to <dialect>` or `--to all` | which dialect(s) to emit (required for `convert`) |
| `--dialect <dialect>` | the dialect to lint against (required for `lint`) |
| `--file <path>` | read the payload from a file instead of stdin |
| `--json` | emit machine-readable JSON |
| `--strict` | exit 1 if any target has a `LOSS` note |
| `--openai-strict` | apply OpenAI structured-outputs strict-mode transforms |

### `--strict`: fail the build on lossy conversions

`--strict` makes `toolerance` exit non-zero when a target would lose information.
Put it in CI to guarantee a tool schema survives a provider intact:

```bash
# fails (exit 1): tuple prefixItems cannot survive gemini-vertex
toolerance convert --from openai --to gemini-vertex --strict --file tuple-tool.json
```

`INFO` and `WARNING` notes never fail the gate. Only `LOSS` does.

### `--openai-strict`: OpenAI structured-outputs mode

OpenAI's strict function-calling mode adds requirements: `additionalProperties`
must be `false` and every property must be `required`. `--openai-strict` applies
those transforms and reports what it changed:

```bash
toolerance convert --from anthropic --to openai --openai-strict --file tool.json
```

## Severities

Every change carries one of three severities, so you can decide what is acceptable:

| Severity | Meaning |
| --- | --- |
| `INFO` | A lossless, reversible change, like renaming `parameters` to `input_schema` or `const` to a single-value `enum`. |
| `WARNING` | A change that keeps the constraint but may alter behavior, like rewriting `oneOf` to `anyOf` (exclusivity is lost) or a tool name the provider may reject. |
| `LOSS` | A constraint the target cannot express, which was dropped, like tuple `prefixItems` into Vertex or `allOf` into Gemini. |

`--strict` gates on `LOSS`. Names and descriptions that break a provider's limits
(dots, length) are flagged and left alone. `toolerance` will not silently rewrite
an identifier your code depends on.

## The seams: what each dialect cannot represent

This table is the core of the tool. OpenAI, Anthropic, and Bedrock accept the full
JSON-Schema subset and keep everything. The two Gemini columns are where schemas
break, and they break differently from each other.

> Verified 2026-07-11. Provider schema support, Gemini's especially, changes often.
> Every Gemini row below was re-checked against current provider docs on this date.
> The columns reflect the `FunctionDeclaration.parameters` tool path that a
> converter emits, where the root must be `type: object`. Each row that is likely to
> go stale is gated by a single named toggle in the source, so a future correction
> is a one-line change plus one test.

| Keyword / feature | openai · responses · anthropic · bedrock | gemini-developer | gemini-vertex |
| --- | --- | --- | --- |
| `$ref` / `$defs` (acyclic) | keep | inline | keep as `ref`/`defs` (no `$`) |
| `$ref` recursion (cycle) | keep | `$ref:"#"` for root self-ref, else loss | depth ≤ 2, else loss |
| `anyOf` | keep | keep | keep |
| `oneOf` | keep | rewrite to `anyOf` (warning) | rewrite to `anyOf` (warning) |
| `allOf` | keep | drop (loss) | drop (loss) |
| `not` | keep | drop (loss) | drop (loss) |
| `additionalProperties` | keep | drop (warning) | keep |
| `patternProperties` | keep | drop (loss) | drop (loss) |
| `propertyNames` | keep | drop (loss) | drop (loss) |
| `minimum` / `maximum` | keep | keep | keep |
| tuple `prefixItems` | keep | keep | rewrite to homogeneous `items` (loss) |
| `const` | keep | rewrite to 1-value `enum` (info) | rewrite to 1-value `enum` (info) |
| non-temporal `format` | keep | drop (warning) | drop (warning) |
| temporal `format` (date/time) | keep | keep | keep |
| nullability | `["T","null"]` union | `nullable: true` (info) | `nullable: true`; `type:"null"` rejected, use `nullable` |
| nesting depth > 32 | not flagged | warning | warning |
| name with dots or length > 64 | warning (flag, never rewrite) | warning | warning |

Three of these rows were stale in older references in a way that would strip
keywords the API now accepts. As of 2026-07-11, Gemini Developer supports `anyOf`,
`minimum`/`maximum`, and `$ref` self-recursion. Shipping the old drop-list would
remove them for no reason.

### The two Geminis, side by side

Here is the single most useful thing `toolerance` tells you: the same schema
converts differently for the two Gemini APIs. Take a schema with `anyOf`,
`additionalProperties`, and tuple `prefixItems`.

- `gemini-developer` keeps `anyOf`, drops `additionalProperties` with a warning
  (it is unreliable on the function-calling path), and keeps `prefixItems`.
- `gemini-vertex` keeps `anyOf`, keeps `additionalProperties`, and loses tuple
  `prefixItems`, degrading it to homogeneous `items`.

Run `--to all` and you see both, each with its own report. You pick the target that
accepts your schema, or you learn what to change before the API rejects it.

## What "robust" means here

- It does not throw. Feed it a number where a schema belongs, a null, or a cycle,
  and you get a best-effort schema plus notes. It stays running. Property-based
  tests feed the pipeline arbitrary junk to keep this true.
- It does not drop anything silently. Every dropped or reshaped keyword produces one
  note with its JSON path.
- It handles deep `$ref`. `$defs`, legacy `definitions`, deep JSON pointers with
  `~0`/`~1` escaping, and `$ref` with sibling keys are all resolved. Unresolvable
  refs are flagged rather than fatal. Recursive refs are detected and handled per
  dialect instead of looping forever.
- The divergence is data, not code. Both Gemini policies live as adjacent tables in
  one file, so the narrow-versus-wide difference is readable at a glance. Two
  hand-written walkers would drift apart and start lying.

## Playground

A self-contained browser playground lives in [playground/index.html](playground/index.html).
Open it in any browser (no server needed) to paste a tool schema and watch it
convert to all six dialects side by side, each card showing what that dialect
drops and whether it would accept the result. Everything runs client-side; nothing
is sent anywhere.

To rebuild it after changing the library:

```bash
pnpm build            # compile the library first
pnpm build:playground # bundle it into playground/index.html
```

The build bundles the dependency-free library into a single inline script, so the
page has no external requests.

## Development

```bash
pnpm install
pnpm build      # tsc --build
pnpm test       # vitest run
pnpm lint       # biome check .
```

## License

MIT
