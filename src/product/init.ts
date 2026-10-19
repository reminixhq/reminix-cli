import { existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { brand } from "../brand/index.ts";
import {
  detectScript,
  inputSchemaForCommand,
  slugOf,
  titleOf,
} from "../internal/domain/product/detect.ts";

import type { Command } from "../cli.ts";
import { localFolder, scriptFiles } from "./scripts.ts";

/**
 * `init [command]` (docs/product/roadmap.md slices 9 and 8): makes a
 * folder holding a script that already exists a Reminix script —
 * reminix.json with its command and an input for every `{name}` in it,
 * and a README.md — for a person or an agent to describe, test-run as a
 * draft, and publish. It never writes code: the script is the one the
 * team already has.
 */

const INIT_HELP = `Say which file and how it runs, like: ${brand.name} init "python report.py --month {month}"`;

/**
 * The command line: as given when it is one (`python x.py {a}`); for a
 * file name, its program and the file; with nothing given, what
 * `publish` would work out for the folder. The same detection publish
 * and the API use (@repo/domain/product/detect), so init and publish
 * agree on every folder.
 */
export function commandFor(dir: string, given?: string): string {
  const line = given?.trim();
  if (line && /\s|\{/.test(line)) return line;
  const folder = localFolder(dir, line ? [line] : scriptFiles(dir));
  const detection = detectScript(folder);
  if (!detection.ok) {
    throw new Error(
      `${detection.error.replace(/ Pass --command .*$/, "")} ${INIT_HELP}`,
    );
  }
  return detection.value.command;
}

/** An input for each `{name}` (required unless inside `[ … ]`), each with a description to fill in. */
export function inputSchemaFor(command: string) {
  const schema = inputSchemaForCommand(command);
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        { ...property, description: "" },
      ]),
    ),
  };
}

/** What `init` writes; returns the files it created. */
export function scaffold(dir: string, given?: string): string[] {
  const manifest = join(dir, "reminix.json");
  if (existsSync(manifest)) {
    throw new Error(`${manifest} already exists`);
  }
  const command = commandFor(dir, given);
  const detected = detectScript(localFolder(dir, scriptFiles(dir)));
  const slug =
    (detected.ok ? detected.value.slug : undefined) ??
    slugOf(basename(resolve(dir))) ??
    "my-script";
  const created: string[] = [];
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        slug,
        name: titleOf(slug),
        description: "",
        command,
        tags: [],
        inputSchema: inputSchemaFor(command),
        hosts: [],
      },
      null,
      2,
    )}\n`,
  );
  created.push("reminix.json");
  if (!existsSync(join(dir, "README.md"))) {
    writeFileSync(
      join(dir, "README.md"),
      `# ${titleOf(slug)}\n\nWhat it does, when to use it, and what its inputs mean.\n`,
    );
    created.push("README.md");
  }
  return created;
}

export const initCommand: Command = (program, ctx) => {
  program
    .command("init [command]")
    .description("Make the script in this folder a Reminix script")
    .addHelpText(
      "after",
      '\nWrites reminix.json (its command, an input per {name}) and README.md.\n[command] is the command as you run it, like "python report.py --month {month}", or just the file.',
    )
    .option("--dir <path>", "the folder (default: the current one)", ".")
    .action((command: string | undefined, options: { dir: string }) => {
      const created = scaffold(options.dir, command);
      ctx.io.stdout(
        `Created ${created.join(", ")}. Describe the inputs in reminix.json, then: ${brand.name} publish ${options.dir === "." ? "" : options.dir}`.trim(),
      );
    });
};
