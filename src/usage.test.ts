import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { describe, expect, it } from "vitest";

import { run, type Io } from "./cli.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;

const body = {
  periodStart: "2026-11-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
  state: "stopped",
  counts: [
    {
      id: "webhook_deliveries",
      label: "Webhook deliveries",
      description: "Webhook deliveries this month",
      used: 12,
      limit: null,
      stopsAt: null,
      state: "within",
    },
    {
      id: "sample_live_checks",
      label: "Live checks",
      description: "Live checks this month",
      used: 1040,
      limit: 1000,
      stopsAt: 1100,
      state: "grace",
    },
    {
      id: "sample_test_checks",
      label: "Test checks",
      description: "Test checks this month",
      used: 100,
      limit: 100,
      stopsAt: 100,
      state: "stopped",
    },
    {
      id: "sample_long_run_minutes",
      label: "Long-run minutes",
      description: "Long-run minutes this month",
      used: 0,
      limit: 0,
      stopsAt: 0,
      state: "within",
    },
  ],
  notices: ["Some usage is unavailable right now."],
};

function terminal() {
  const out: string[] = [];
  const io: Io = {
    env: {
      [`${brand.identifier.toUpperCase()}_TOKEN`]: PAT,
      [`${brand.identifier.toUpperCase()}_WORKSPACE`]: "acme",
    },
    homeDir: mkdtempSync(join(tmpdir(), "cli-usage-")),
    fetch: async () => Response.json(body),
    stdout: (line) => out.push(line),
    stderr: () => {},
    stdin: async () => "",
  };
  return { io, out };
}

describe("workspace usage", () => {
  it("says each count's figures and where it stands, as the app does", async () => {
    const t = terminal();
    expect(await run(["workspace", "usage"], t.io)).toBe(0);
    expect(t.out).toEqual([
      "Usage this period. Counters reset on Dec 1, 2026.",
      "Webhook deliveries: 12 (no limit).",
      `Live checks: 1,040 of 1,000. Over your plan. Past 1,100, ${brand.productName} refuses new use.`,
      `Test checks: 100 of 100. ${brand.productName} refuses new use until Dec 1, 2026.`,
      "Long-run minutes: 0 of 0. Not in your plan.",
      "Some usage is unavailable right now.",
    ]);
  });

  it("prints the API's response as it is with --json", async () => {
    const t = terminal();
    expect(await run(["workspace", "usage", "--json"], t.io)).toBe(0);
    expect(JSON.parse(t.out.join("\n"))).toEqual(body);
  });
});
