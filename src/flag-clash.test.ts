import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "./cli.ts";

/**
 * No command may take a flag the CLI itself takes (`--version`,
 * `--environment`, …): the CLI's wins wherever it appears, so the
 * command's never arrives. Reminix's `run --version 1` printed the CLI's
 * version instead of running (2026-10-19). Covers the product's commands
 * too: this builds the real tree.
 */
describe("command flags", () => {
  it("never reuse a flag of the CLI itself", () => {
    const program = createProgram({
      env: {},
      homeDir: mkdtempSync(join(tmpdir(), "cli-flags-")),
      fetch: async () => Response.json({}),
      stdout: () => {},
      stderr: () => {},
      stdin: async () => "",
    });
    const own = new Set(
      program.options.flatMap((option) =>
        [option.long, option.short].filter((flag) => flag !== undefined),
      ),
    );
    expect(own).toContain("--version");
    const clashes: string[] = [];
    const walk = (command: Command, path: string) => {
      for (const sub of command.commands) {
        const name = `${path} ${sub.name()}`.trim();
        for (const option of sub.options) {
          for (const flag of [option.long, option.short]) {
            if (flag !== undefined && own.has(flag)) {
              clashes.push(`${name} ${flag}`);
            }
          }
        }
        walk(sub, name);
      }
    };
    walk(program, "");
    expect(clashes).toEqual([]);
  });
});
