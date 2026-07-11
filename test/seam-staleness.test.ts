import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(__dirname, "..", "scripts", "check-seam-staleness.mjs");

function run(env: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status ?? 1 };
  }
}

describe("check-seam-staleness", () => {
  it("is not stale relative to the current committed verification date", () => {
    const { stdout, status } = run();
    const result = JSON.parse(stdout);
    expect(status).toBe(0);
    expect(result.stale).toBe(false);
  });

  it("reports stale once the injected 'now' passes the 90-day window", () => {
    const { stdout, status } = run({ SEAM_STALENESS_NOW: "2026-11-01" });
    const result = JSON.parse(stdout);
    expect(status).toBe(1);
    expect(result.stale).toBe(true);
    expect(result.ageDays).toBeGreaterThan(90);
  });

  it("includes all four stale-risk toggles in the issue body", () => {
    const { stdout } = run({ SEAM_STALENESS_NOW: "2026-11-01" });
    const result = JSON.parse(stdout);
    expect(result.body).toContain("GEMINI_DEVELOPER_SUPPORTS_ANYOF");
    expect(result.body).toContain("GEMINI_DEVELOPER_SUPPORTS_MIN_MAX");
    expect(result.body).toContain("GEMINI_DEVELOPER_SUPPORTS_PREFIX_ITEMS");
    expect(result.body).toContain("GEMINI_DEVELOPER_ADDITIONAL_PROPERTIES_RELIABLE");
  });

  it("stays just under the boundary at exactly 90 days", () => {
    const { stdout, status } = run({ SEAM_STALENESS_NOW: "2026-10-09" });
    const result = JSON.parse(stdout);
    expect(result.ageDays).toBeLessThanOrEqual(90);
    expect(status).toBe(0);
    expect(result.stale).toBe(false);
  });
});
