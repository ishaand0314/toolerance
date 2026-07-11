#!/usr/bin/env node
/**
 * Build the self-contained playground page.
 *
 * The playground runs the whole converter client-side: the library (index.ts)
 * has no runtime dependencies and no Node built-ins, so esbuild bundles it into a
 * single browser IIFE that exposes `window.toolerance`. This script bundles the
 * built library, then inlines the bundle into template.html at the `/*BUNDLE*​/`
 * marker to produce a single, dependency-free index.html that works from a file://
 * URL or any static host (and is publishable as an Artifact).
 *
 * Run `pnpm build` first (this reads dist/index.js). Then `pnpm build:playground`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const result = await build({
  entryPoints: [join(root, "dist", "index.js")],
  bundle: true,
  format: "iife",
  globalName: "toolerance",
  minify: true,
  write: false,
  target: ["es2020"],
});

const bundle = result.outputFiles[0].text;

const template = readFileSync(join(here, "template.html"), "utf8");
if (!template.includes("/*BUNDLE*/")) {
  throw new Error("template.html is missing the /*BUNDLE*/ marker");
}
const html = template.replace("/*BUNDLE*/", () => bundle);

const outPath = join(here, "index.html");
writeFileSync(outPath, html);
console.log(`playground built: ${outPath} (${Math.round(html.length / 1024)} kB)`);
