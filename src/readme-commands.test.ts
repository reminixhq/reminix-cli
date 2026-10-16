import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "./cli.ts";

/**
 * Every CLI command a package README shows (docs/product/readme/*.md,
 * scripts/release/readme.mjs) exists: its words lead to a command that
 * runs, not a group. A renamed command fails here, not on npm's page.
 */
const root = new URL("../../..", import.meta.url).pathname;
const dir = join(root, "docs/product/readme");

function commandLines(markdown: string) {
  const lines: string[] = [];
  for (const [, body] of markdown.matchAll(
    /```(?:bash|sh|shell)\n([\s\S]*?)```/g,
  )) {
    for (const raw of body.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (line.startsWith(`${brand.name} `) || line === brand.name)
        lines.push(line);
    }
  }
  return lines;
}

/** The command a line names, or why it names none. */
export function resolve(program: Command, line: string) {
  let command = program;
  for (const word of line.split(/\s+/).slice(1)) {
    if (word.startsWith("-") || /^["'<$]/.test(word)) break;
    const sub = command.commands.find(
      (c) => c.name() === word || c.aliases().includes(word),
    );
    if (!sub) break;
    command = sub;
  }
  if (command === program) return { error: `"${line}" names no command` };
  const groups = command.commands.filter((c) => c.name() !== "help");
  if (groups.length > 0 && !/\s--help\b/.test(line)) {
    return { error: `"${line}" stops at the group "${command.name()}"` };
  }
  return { command: command.name() };
}

describe("the commands in the package READMEs", () => {
  const program = createProgram({
    env: {},
    homeDir: "/nonexistent",
    fetch: () => Promise.reject(new Error("no network")),
    stdout: () => {},
    stderr: () => {},
    stdin: async () => "",
  });

  it("resolves a real command and refuses a group or a typo", () => {
    expect(resolve(program, `${brand.name} whoami --json`)).toEqual({
      command: "whoami",
    });
    expect(resolve(program, `${brand.name} workspace`).error).toMatch(
      /stops at the group/,
    );
    expect(resolve(program, `${brand.name} nope`).error).toMatch(
      /names no command/,
    );
  });

  for (const file of ["cli.md", "sdk.md", "python.md"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    for (const line of commandLines(readFileSync(path, "utf8"))) {
      it(`${file}: ${line}`, () => {
        expect(resolve(program, line).error).toBeUndefined();
      });
    }
  }
});
