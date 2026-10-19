import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadScriptDir } from "./scripts.ts";
import { commandFor, inputSchemaFor, scaffold } from "./init.ts";

describe("init", () => {
  it("describes the script already in the folder, which then packs as-is", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "init-")), "Monthly Report");
    mkdirSync(dir);
    writeFileSync(join(dir, "report.py"), "print('report')\n");
    expect(
      scaffold(dir, "python report.py --month {month} [--limit {limit}]"),
    ).toEqual(["reminix.json", "README.md"]);
    const manifest = JSON.parse(
      readFileSync(join(dir, "reminix.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      slug: "monthly-report",
      name: "Monthly report",
      command: "python report.py --month {month} [--limit {limit}]",
      inputSchema: {
        required: ["month"],
        properties: { month: { type: "string" }, limit: { type: "string" } },
      },
    });
    // It never writes code: the script is the one already there.
    expect(readFileSync(join(dir, "report.py"), "utf8")).toBe(
      "print('report')\n",
    );
    const loaded = loadScriptDir(dir);
    expect(loaded.files).toEqual(["README.md", "reminix.json", "report.py"]);
    expect(loaded.readme).toContain("# Monthly report");
    expect(() => scaffold(dir)).toThrow(/already exists/);
  });

  it("finds the one script file, and its program", () => {
    const dir = mkdtempSync(join(tmpdir(), "init-"));
    writeFileSync(join(dir, "sync.ts"), "");
    writeFileSync(join(dir, "vite.config.ts"), "");
    expect(commandFor(dir)).toBe("node sync.ts");
    expect(commandFor(dir, "convert.sh")).toBe("sh convert.sh");
    expect(commandFor(dir, "main.py")).toBe("python main.py");
    writeFileSync(join(dir, "other.py"), "");
    expect(() => commandFor(dir)).toThrow(/Several script files/);
  });

  it("makes an input for every {name}, optional inside [ … ]", () => {
    expect(inputSchemaFor("node x.js {a} [--b={b}] {a}")).toEqual({
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", description: "" },
        b: { type: "string", description: "" },
      },
    });
  });

  it("agrees with publish on a folder init once refused", () => {
    // Two scripts, one of them the entry: publish runs main.py, and so
    // does init (it had its own rules and refused "Several script files").
    const dir = mkdtempSync(join(tmpdir(), "init-"));
    writeFileSync(join(dir, "main.py"), "");
    writeFileSync(join(dir, "helpers.py"), "");
    writeFileSync(join(dir, "test_main.py"), "");
    expect(commandFor(dir)).toBe("python main.py");
    expect(loadScriptDir(dir).detected?.command).toBe("python main.py");
    // A package's name sets the slug, as for publish.
    const pkg = mkdtempSync(join(tmpdir(), "init-"));
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@acme/monthly-report", main: "index.js" }),
    );
    expect(scaffold(pkg)).toContain("reminix.json");
    expect(
      JSON.parse(readFileSync(join(pkg, "reminix.json"), "utf8")),
    ).toMatchObject({
      slug: "monthly-report",
      name: "Monthly report",
      command: "node index.js",
    });
  });
});
