import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { brand } from "../brand/index.ts";

import type { Command } from "../cli.ts";

/**
 * `init [command]` (docs/product/roadmap.md slices 9 and 8): makes a
 * folder holding a script that already exists a Reminix script —
 * reminix.json with its command and an input for every `{name}` in it,
 * and a README.md — for a person or an agent to describe, test-run as a
 * draft, and publish. It never writes code: the script is the one the
 * team already has.
 */

/** A slug the API accepts, from a folder name ("My Report!" → "my-report"). */
export function slugFrom(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : "my-script";
}

const titleFrom = (slug: string) =>
  slug
    .split("-")
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

/** The program for a script file, by its extension. */
export function programFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".py") return "python";
  if ([".js", ".mjs", ".cjs", ".ts", ".mts"].includes(ext)) return "node";
  if (ext === ".sh") return "sh";
  if (ext === "") return `./${file}`;
  throw new Error(
    `${file}: say how to run it, like: ${brand.name} init "python ${file} --month {month}"`,
  );
}

const SCRIPT_FILE = /\.(py|sh|js|mjs|cjs|ts|mts)$/i;
const NOT_A_SCRIPT = /(\.config\.|^setup\.py$|^conftest\.py$|\.d\.ts$)/i;

/** The one script file in the folder, when there is exactly one. */
function onlyScript(dir: string): string {
  const files = readdirSync(dir).filter(
    (f) => SCRIPT_FILE.test(f) && !NOT_A_SCRIPT.test(f),
  );
  if (files.length !== 1) {
    throw new Error(
      `${files.length === 0 ? "No script file here" : `Several script files here (${files.join(", ")})`} — say which and how it runs, like: ${brand.name} init "python report.py --month {month}"`,
    );
  }
  return files[0];
}

/**
 * The command line: as given when it is one (`python x.py {a}`); for a
 * file name, its program and the file.
 */
export function commandFor(dir: string, given?: string): string {
  const line = given?.trim() || onlyScript(dir);
  return /\s|\{/.test(line) ? line : `${programFor(line)} ${line}`;
}

/** An input for each `{name}`: required, unless inside `[ … ]`. */
export function inputSchemaFor(command: string) {
  const optional = new Set(
    [...command.matchAll(/\[[^\]]*\]/g)].flatMap((group) =>
      [...group[0].matchAll(/\{([A-Za-z_][\w-]*)\}/g)].map((m) => m[1]),
    ),
  );
  const names = [
    ...new Set(
      [...command.matchAll(/\{([A-Za-z_][\w-]*)\}/g)].map((m) => m[1]),
    ),
  ];
  return {
    type: "object",
    required: names.filter((name) => !optional.has(name)),
    properties: Object.fromEntries(
      names.map((name) => [name, { type: "string", description: "" }]),
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
  const slug = slugFrom(basename(resolve(dir)));
  const created: string[] = [];
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        slug,
        name: titleFrom(slug),
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
      `# ${titleFrom(slug)}\n\nWhat it does, when to use it, and what its inputs mean.\n`,
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
