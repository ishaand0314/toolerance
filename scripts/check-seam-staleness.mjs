#!/usr/bin/env node
/**
 * Checks whether src/walk.ts's Gemini verification date has gone stale
 * (>90 days old) and, if so, prints a GitHub issue title/body for the
 * doc-drift-guard workflow to open or update. Exits 1 when stale, 0 otherwise,
 * so the workflow step can branch on it without parsing output.
 *
 * Usage: node scripts/check-seam-staleness.mjs [--max-age-days=90]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const walkPath = join(here, "..", "src", "walk.ts");

const maxAgeArg = process.argv.find((a) => a.startsWith("--max-age-days="));
const MAX_AGE_DAYS = maxAgeArg ? Number(maxAgeArg.split("=")[1]) : 90;

const source = readFileSync(walkPath, "utf8");

const dateMatch = source.match(/VERIFICATION DATE:\s*(\d{4}-\d{2}-\d{2})/);
if (!dateMatch) {
  console.error("Could not find a 'VERIFICATION DATE: YYYY-MM-DD' header in src/walk.ts");
  process.exit(2);
}
const verificationDate = dateMatch[1];

const toggleNames = [
  "GEMINI_DEVELOPER_SUPPORTS_ANYOF",
  "GEMINI_DEVELOPER_SUPPORTS_MIN_MAX",
  "GEMINI_DEVELOPER_SUPPORTS_PREFIX_ITEMS",
  "GEMINI_DEVELOPER_ADDITIONAL_PROPERTIES_RELIABLE",
];
const toggles = toggleNames.map((name) => {
  const re = new RegExp(`const ${name}\\s*=\\s*(true|false)`);
  const m = source.match(re);
  return { name, value: m ? m[1] : "unknown" };
});

const now = process.env.SEAM_STALENESS_NOW ? new Date(process.env.SEAM_STALENESS_NOW) : new Date();
const verified = new Date(`${verificationDate}T00:00:00Z`);
const ageDays = Math.floor((now.getTime() - verified.getTime()) / (1000 * 60 * 60 * 24));

const stale = ageDays > MAX_AGE_DAYS;

const toggleList = toggles.map((t) => `- \`${t.name}\` = \`${t.value}\``).join("\n");

const title = "Gemini seam facts need re-verification";
const body = `The Gemini dialect facts in \`src/walk.ts\` were last verified on **${verificationDate}** (${ageDays} days ago), past the ${MAX_AGE_DAYS}-day staleness window.

Provider schema support moves fast, especially Gemini's. Please re-check each row in the seams table against current provider docs and update the verification date.

**Toggles to re-verify** (each gates one stale-risk keyword; flip and update the matching test in \`test/seams.test.ts\` if a fact has changed):

${toggleList}

See \`src/walk.ts\`'s header comment for sources and the "CLAUDE.md" section "When you touch the dialect facts" for the update checklist. The \`seam-verifier\` agent can do this re-check.

This issue was opened automatically by the doc-drift-guard workflow.`;

console.log(
  JSON.stringify(
    { stale, ageDays, verificationDate, maxAgeDays: MAX_AGE_DAYS, title, body },
    null,
    2,
  ),
);

process.exit(stale ? 1 : 0);
