import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
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

/**
 * Creates `path` only if nothing is there yet (the `wx` flag: the check
 * and the create are one step, so nothing can appear in between). Returns
 * its descriptor, or null when it already exists.
 */
function createNew(path: string): number | null {
  try {
    return openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

/** What `init` writes; returns the files it created. */
export function scaffold(dir: string, given?: string): string[] {
  const manifest = join(dir, "reminix.json");
  const alreadyExists = () => new Error(`${manifest} already exists`);
  let command: string;
  try {
    command = commandFor(dir, given);
  } catch (error) {
    // An existing reminix.json is the error to report, as before.
    let probe: number | null;
    try {
      probe = createNew(manifest);
    } catch {
      throw error; // no folder to write in: the detection error stands
    }
    if (probe === null) throw alreadyExists();
    closeSync(probe);
    unlinkSync(manifest);
    throw error;
  }
  const detected = detectScript(localFolder(dir, scriptFiles(dir)));
  const slug =
    (detected.ok ? detected.value.slug : undefined) ??
    slugOf(basename(resolve(dir))) ??
    "my-script";
  writeNew(
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
    alreadyExists,
  );
  const created = ["reminix.json"];
  const readme = `# ${titleOf(slug)}\n\nWhat it does, when to use it, and what its inputs mean.\n`;
  if (writeNew(join(dir, "README.md"), readme)) created.push("README.md");
  return created;
}

/**
 * Writes `content` to `path` only if nothing is there yet; false (or
 * `onExists`'s error) when something is.
 */
function writeNew(
  path: string,
  content: string,
  onExists?: () => Error,
): boolean {
  const fd = createNew(path);
  if (fd === null) {
    if (onExists) throw onExists();
    return false;
  }
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
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
