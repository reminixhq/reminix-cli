import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { brand } from "../brand/index.ts";
import {
  detectScript,
  slugOf,
  titleOf,
  type Detected,
  type Folder,
} from "../internal/domain/product/detect.ts";
import type { Schemas } from "@reminix/sdk";

import type { Command as Commander } from "commander";

import type { CliContext, Command } from "../cli.ts";
import { covers } from "../covers.ts";
import { rawRequest } from "../http.ts";
import { json } from "../output.ts";
import { describeOutputs, saveOutputs, uploadPath } from "./files.ts";

/**
 * `reminix publish [dir...]` (short for `reminix scripts publish`) — the
 * path from a folder in someone's repository to a script
 * (docs/product/roadmap.md slices 1 and 8): read `reminix.json`, pack
 * the folder as it is (its files, not its installed dependencies —
 * those are installed at publish from requirements.txt or
 * package.json), create the script if it does not exist, upload a
 * version and publish it — or, with `--draft`, leave it a draft to test
 * and publish later (agents use `--draft` and ask a person).
 */

/** The packed folder's limit, as the API enforces it. */
export const MAX_ARCHIVE_BYTES = 10_000_000;

export type Manifest = {
  slug: string;
  name: string;
  description?: string;
  /**
   * What a run executes: `python convert.py --account {account} …`.
   * Left out, the API works it out from the folder (detect.ts).
   */
  command?: string;
  /** Replaces the usual install (requirements.txt, package.json). */
  build?: string;
  /** Left out: an input for each `{name}` in the command. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  /** The only hosts the script may reach (slice 2). */
  hosts?: string[];
  /** Secrets attached to its requests: name → { hosts (or host), header, value? }. */
  secrets?: Record<
    string,
    { hosts?: string[]; host?: string; header: string; value?: string }
  >;
  /** Secrets the script reads as environment variables (each must allow it). */
  env?: string[];
  /** Up to 10, lowercase — how the team finds it (slice 7). */
  tags?: string[];
  /** Seconds a run may take (default 30; up to 900 — slice 6). */
  timeout?: number;
};

/** README.md beside reminix.json, if any: the script's page shows it. */
export function readReadme(dir: string): string | null {
  for (const name of ["README.md", "readme.md", "Readme.md"]) {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      // not this name
    }
  }
  return null;
}

/** What `publish` takes on the command line, over reminix.json and the folder. */
export type PublishFlags = { command?: string; name?: string; slug?: string };

/** The folder as detection reads it (the same function the API runs). */
function localFolder(dir: string, files: string[]): Folder {
  return {
    files,
    read: (path) => {
      try {
        const full = join(dir, path);
        return statSync(full).size <= 1_000_000
          ? readFileSync(full, "utf8")
          : null;
      } catch {
        return null;
      }
    },
    executable: (path) => {
      try {
        return (statSync(join(dir, path)).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
    name: basename(resolve(dir)),
  };
}

/**
 * Reads a script folder and packs it. Each value comes from, in order:
 * reminix.json, the flags, then the folder itself (pyproject.toml,
 * package.json, its one script: docs/product/design-publish.md). The
 * command left unset is the API's to work out, with the same function;
 * `detected` is what this folder says, for the CLI to show.
 */
export function loadScriptDir(
  dir: string,
  flags: PublishFlags = {},
): {
  manifest: Manifest;
  archive: Buffer;
  files: string[];
  readme: string | null;
  detected: Detected | null;
} {
  const manifestPath = join(dir, "reminix.json");
  let given: Partial<Manifest> = {};
  if (existsSync(manifestPath)) {
    try {
      given = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    } catch (error) {
      throw new Error(
        `Cannot read ${manifestPath}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (
      given.inputSchema !== undefined &&
      (!given.inputSchema || typeof given.inputSchema !== "object")
    ) {
      throw new Error(
        'reminix.json: "inputSchema" must be a JSON Schema object',
      );
    }
  }
  const files = scriptFiles(dir);
  const command = given.command ?? flags.command?.trim();
  const detection = detectScript(localFolder(dir, files));
  if (!command && !detection.ok) throw new Error(detection.error);
  const detected = detection.ok ? detection.value : null;
  const slug =
    given.slug ??
    flags.slug ??
    detected?.slug ??
    slugOf(basename(resolve(dir))) ??
    "my-script";
  const manifest: Manifest = {
    ...given,
    slug,
    name: given.name ?? flags.name ?? detected?.name ?? titleOf(slug),
    description: given.description ?? detected?.description,
    command: command || undefined,
  };
  return {
    manifest,
    files,
    archive: pack(dir, files),
    readme: readReadme(dir),
    detected: command ? null : detected,
  };
}

/** Never uploaded: installed dependencies, caches, version control. */
const SKIPPED = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".deps",
  ".DS_Store",
  ".env",
]);
const skipped = (path: string) =>
  path.split("/").some((part) => SKIPPED.has(part)) || path.endsWith(".pyc");

/**
 * The folder's files: what git tracks or would track (so .gitignore
 * applies) when the folder is in a repository, otherwise everything —
 * minus installed dependencies, caches and `.env` files either way.
 */
export function scriptFiles(dir: string): string[] {
  const git = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "."],
    { cwd: dir, encoding: "utf8" },
  );
  const listed =
    git.status === 0 ? git.stdout.split("\0").filter(Boolean) : walk(dir, dir);
  return listed.filter((path) => !skipped(path)).sort();
}

function walk(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (SKIPPED.has(entry.name)) return [];
    if (entry.isDirectory()) return walk(root, path);
    return entry.isFile() ? [relative(root, path).split("\\").join("/")] : [];
  });
}

/** The files as a .tar.gz (the system's tar: macOS, Linux and Windows have one). */
export function pack(dir: string, files: string[]): Buffer {
  const size = files.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  if (size > MAX_ARCHIVE_BYTES * 5) {
    throw new Error(
      `The folder holds ${(size / 1_000_000).toFixed(1)} MB of files — leave out data and installed dependencies (they are installed at publish)`,
    );
  }
  const tar = spawnSync("tar", ["-czf", "-", "--null", "-T", "-"], {
    cwd: dir,
    input: files.join("\0"),
    maxBuffer: MAX_ARCHIVE_BYTES * 2,
    // macOS: no AppleDouble (._*) files in the archive.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (tar.status !== 0) {
    throw new Error(
      `Could not pack the folder: ${tar.stderr?.toString().trim() || tar.error?.message}`,
    );
  }
  if (tar.stdout.length > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `The packed folder is ${(tar.stdout.length / 1_000_000).toFixed(1)} MB — at most ${MAX_ARCHIVE_BYTES / 1_000_000} MB (leave out data and installed dependencies)`,
    );
  }
  return tar.stdout;
}

type ApiFailure = Error & { status?: number };

/** How often `run` checks on a long run while following it. */
export const POLL_MS = 2000;

/** A command's options and action, shared by the long form and its shortcut. */
type Define = (command: Commander, ctx: CliContext) => Commander;

/** A folder that says how it runs: a reminix.json, or what publish recognises. */
function isScript(dir: string): boolean {
  return (
    existsSync(join(dir, "reminix.json")) ||
    detectScript(localFolder(dir, scriptFiles(dir))).ok
  );
}

/** A project, whatever its subfolders: a reminix.json, pyproject.toml or package.json. */
const isProject = (dir: string) =>
  ["reminix.json", "pyproject.toml", "package.json"].some((file) =>
    existsSync(join(dir, file)),
  );

/**
 * The script folders the arguments name, in order: a project (a
 * reminix.json, pyproject.toml or package.json) is one script; else a
 * folder whose subfolders are scripts (a reminix.json, or a layout
 * publish recognises: a project file, its one .py, .js, .ts or .sh
 * file) stands for each of those, sorted by name, the other subfolders
 * left out and named in `skipped`; else the folder is one script, whose
 * publish runs on its own files or says what is missing. No argument: the current folder. A path that isn't a
 * folder is an error for it.
 */
export function scriptFolders(dirs: string[]): {
  folders: string[];
  missing: string[];
  skipped: string[];
} {
  const folders: string[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  for (const dir of dirs.length > 0 ? dirs : ["."]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      missing.push(dir);
      continue;
    }
    // A project is one script (publish says what is missing, if
    // anything): its subfolders are its own, never scripts of their own.
    if (isProject(dir)) {
      folders.push(dir);
      continue;
    }
    const subfolders = readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !SKIPPED.has(entry.name),
      )
      .map((entry) => join(dir, entry.name))
      .sort();
    const scripts = subfolders.filter(isScript);
    if (scripts.length === 0) {
      folders.push(dir);
      continue;
    }
    folders.push(...scripts);
    skipped.push(...subfolders.filter((sub) => !scripts.includes(sub)));
  }
  return { folders, missing, skipped };
}

type PublishOptions = PublishFlags & {
  draft?: boolean;
  /** Publish this already-uploaded version (a tested draft) instead. */
  number?: string;
  plan?: boolean;
  workspace?: string;
};

const KIND = { python: "Python", node: "Node", shell: "Shell" } as const;

/** What publish found in a folder without a command: shown before uploading. */
export function describeDetected(
  manifest: Manifest,
  detected: Detected | null,
) {
  const lines = detected
    ? [`${KIND[detected.kind]} script (${detected.source})`]
    : ["From reminix.json and the flags"];
  lines.push(`  slug     ${manifest.slug}`, `  name     ${manifest.name}`);
  const command = manifest.command ?? detected?.command;
  if (command) lines.push(`  command  ${command}`);
  return lines.join("\n");
}

/** Creates the script if needed, uploads a version, publishes it unless a draft. */
async function publishFolder(
  ctx: CliContext,
  dir: string,
  options: PublishOptions,
) {
  const { manifest, archive, readme, detected } = loadScriptDir(dir, options);
  if (options.plan) {
    return {
      slug: manifest.slug,
      version: null,
      script: null,
      line: `${describeDetected(manifest, detected)}\nNothing was uploaded (--plan).`,
    };
  }
  const call = (method: string, path: string, body?: unknown) =>
    rawRequest(ctx, { method, path, body, workspace: options.workspace });
  const slug = encodeURIComponent(manifest.slug);
  if (options.number !== undefined) {
    // The draft you tested, published as it is: nothing is uploaded.
    const number = Number(options.number);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error("--number: a version number, like --number 3");
    }
    if (options.draft) {
      throw new Error(
        "--number publishes a version already uploaded; leave out --draft",
      );
    }
    const script = await call(
      "POST",
      `/v1/scripts/${slug}/versions/${number}/publish`,
    );
    const approveUrl =
      (script as { approval?: { approveUrl: string } }).approval?.approveUrl ??
      null;
    return {
      slug: manifest.slug,
      version: { number },
      script,
      line: approveUrl
        ? `Publishing ${manifest.slug} version ${number} waits for a person's approval: ${approveUrl}`
        : `Published ${manifest.slug} version ${number}.`,
    };
  }
  try {
    await call("GET", `/v1/scripts/${slug}`);
  } catch (error) {
    if ((error as ApiFailure).status !== 404) throw error;
    await call("POST", "/v1/scripts", {
      slug: manifest.slug,
      name: manifest.name,
      description: manifest.description,
    });
  }
  const version = (await call("POST", `/v1/scripts/${slug}/versions`, {
    command: manifest.command,
    build: manifest.build ?? null,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema ?? null,
    hosts: manifest.hosts,
    secrets: manifest.secrets,
    env: manifest.env,
    tags: manifest.tags,
    timeout: manifest.timeout,
    readme,
    archive: archive.toString("base64"),
    via: "cli",
  })) as { number: number };
  let script: unknown = null;
  let approveUrl: string | null = null;
  if (!options.draft) {
    script = await call(
      "POST",
      `/v1/scripts/${slug}/versions/${version.number}/publish`,
    );
    // Sent to a person instead (the workspace requires a second one).
    approveUrl =
      (script as { approval?: { approveUrl: string } }).approval?.approveUrl ??
      null;
  }
  const line = approveUrl
    ? `Uploaded ${manifest.slug} version ${version.number}; publishing waits for a person's approval: ${approveUrl}`
    : options.draft
      ? `Uploaded ${manifest.slug} version ${version.number} as a draft. Publish it in the app, or run \`${brand.name} publish\` again without --draft.`
      : `Published ${manifest.slug} version ${version.number}.`;
  const found = detected ? `${describeDetected(manifest, detected)}\n` : "";
  return { slug: manifest.slug, version, script, line: `${found}${line}` };
}

const definePublish: Define = (command, ctx) =>
  covers(
    command,
    "scripts.create",
    "scriptVersions.create",
    "scriptVersions.publish",
  )
    .option(
      "--draft",
      "upload a draft to test and publish later (agents use it and ask a person)",
    )
    .option(
      "--number <n>",
      "publish version n, already uploaded (the draft you tested), instead of uploading",
    )
    .option(
      "--command <line>",
      'how it runs, when the folder doesn\'t say: "python report.py {month}"',
    )
    .option("--name <name>", "the name people see (default: from the folder)")
    .option(
      "--slug <slug>",
      "its id in URLs and commands (default: from the folder)",
    )
    .option("--plan", "show what would be published, and upload nothing")
    .option("--workspace <slug>", "act in this workspace for one call")
    .option("--json", "machine-readable output")
    .addHelpText(
      "after",
      `\nPublishes the folder as it is: it says how it runs (pyproject.toml, package.json,\nor its one .py, .js, .ts or .sh file). Customize it with a reminix.json.\nSeveral folders publish one after another; a folder of scripts publishes each\nsubfolder that is one: \`${brand.name} publish scripts/\` publishes them all.`,
    )
    .action(
      async (dirs: string[], options: PublishOptions & { json?: boolean }) => {
        const { folders, missing, skipped } = scriptFolders(dirs);
        for (const dir of skipped) {
          if (!options.json) ctx.io.stderr(`Skipped ${dir}: no script in it`);
        }
        if (
          options.number !== undefined &&
          folders.length + missing.length !== 1
        ) {
          throw new Error("--number publishes one script: name one folder");
        }
        // One folder: its result as before; several: one entry per folder.
        if (folders.length === 1 && missing.length === 0) {
          const result = await publishFolder(ctx, folders[0], options);
          ctx.io.stdout(
            options.json
              ? json({ version: result.version, script: result.script })
              : result.line,
          );
          return;
        }
        const results: Record<string, unknown>[] = [];
        const failed: string[] = [];
        const fail = (dir: string, message: string) => {
          failed.push(dir);
          results.push({ dir, error: message });
          if (!options.json) ctx.io.stderr(`${dir}: ${message}`);
        };
        for (const dir of missing) {
          fail(dir, "not a folder");
        }
        for (const dir of folders) {
          try {
            const result = await publishFolder(ctx, dir, options);
            results.push({
              dir,
              version: result.version,
              script: result.script,
            });
            if (!options.json) ctx.io.stdout(result.line);
          } catch (error) {
            // Carry on with the rest; the summary names every failure.
            fail(dir, (error as Error).message);
          }
        }
        if (options.json) ctx.io.stdout(json(results));
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} of ${folders.length + missing.length} failed: ${failed.join(", ")}`,
          );
        }
      },
    );

const defineRun: Define = (command, ctx) =>
  covers(command, "runs.create", "scriptVersions.run")
    .option("--input <json>", "the inputs, as a JSON object", "{}")
    .option(
      "--file <input=path>",
      "upload a file as a file input (repeat it for several)",
      (value: string, all: string[]) => [...all, value],
      [] as string[],
    )
    .option(
      "--out <dir>",
      "save the files the run writes here (else their links are printed)",
    )
    // --number, like `publish --number`: `--version` is the CLI's own
    // (it prints the CLI's version, whatever command it follows).
    .option(
      "--number <n>",
      "test-run version n (a draft) instead of the published one",
    )
    .option("--log", "also print what the run logged (to stderr)")
    .option("--workspace <slug>", "act in this workspace for one call")
    .option("--json", "print the whole run, not just its output")
    .action(
      async (
        slug: string,
        options: {
          input: string;
          file: string[];
          out?: string;
          number?: string;
          log?: boolean;
          workspace?: string;
          json?: boolean;
        },
      ) => {
        let inputs: unknown;
        try {
          inputs = JSON.parse(options.input);
        } catch (error) {
          throw new Error(
            `--input: not valid JSON (${(error as Error).message})`,
            {
              cause: error,
            },
          );
        }
        if (
          inputs === null ||
          typeof inputs !== "object" ||
          Array.isArray(inputs)
        ) {
          throw new Error(
            '--input: must be a JSON object, e.g. \'{"orderId":"o_1"}\'',
          );
        }
        const call = (method: string, path: string, body?: unknown) =>
          rawRequest(ctx, { method, path, body, workspace: options.workspace });
        // --file input=path: uploaded first, given by id (slice 8).
        if (options.file.length > 0) {
          const byInput = new Map<string, string[]>();
          for (const spec of options.file) {
            const at = spec.indexOf("=");
            if (at <= 0 || at === spec.length - 1) {
              throw new Error(
                `--file: input=path, e.g. --file statement=./sept.pdf (got "${spec}")`,
              );
            }
            const name = spec.slice(0, at);
            byInput.set(name, [
              ...(byInput.get(name) ?? []),
              spec.slice(at + 1),
            ]);
          }
          const script = (await call(
            "GET",
            `/v1/scripts/${encodeURIComponent(slug)}`,
          )) as {
            inputSchema: { properties?: Record<string, { type?: unknown }> };
          };
          const properties = script.inputSchema?.properties ?? {};
          for (const [name, paths] of byInput) {
            const ids: string[] = [];
            for (const path of paths) {
              ids.push((await uploadPath(ctx, path, options.workspace)).id);
            }
            (inputs as Record<string, unknown>)[name] =
              properties[name]?.type === "array" || ids.length > 1
                ? ids
                : ids[0];
          }
        }
        if (
          options.number !== undefined &&
          !/^[1-9]\d*$/.test(options.number)
        ) {
          throw new Error("--number: a version number, like --number 2");
        }
        let run = (await call(
          "POST",
          options.number === undefined
            ? `/v1/scripts/${encodeURIComponent(slug)}/runs`
            : `/v1/scripts/${encodeURIComponent(slug)}/versions/${options.number}/runs`,
          { inputs, via: "cli" },
        )) as {
          id: string;
          status: string;
          output: unknown;
          error: string | null;
          approval?: { approveUrl: string } | null;
          files?: Schemas["File"][];
        };
        if (run.status === "awaiting_approval") {
          ctx.io.stdout(
            options.json
              ? json(run)
              : `Waiting for a person's approval (run ${run.id}): ${run.approval?.approveUrl ?? "see Approvals in the app"}`,
          );
          return;
        }
        let printed = 0;
        const printLog = async () => {
          if (!options.log) return;
          const { lines } = (await call(
            "GET",
            `/v1/runs/${encodeURIComponent(run.id)}/logs`,
          )) as { lines: string[] };
          for (const line of lines.slice(printed)) ctx.io.stderr(line);
          printed = Math.max(printed, lines.length);
        };
        // A long run (slice 6) answers while it runs: follow it to the end.
        while (run.status === "running") {
          await printLog();
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          run = (await call(
            "GET",
            `/v1/runs/${encodeURIComponent(run.id)}`,
          )) as typeof run;
        }
        await printLog();
        // What it wrote: saved with --out, else where to get it (stderr,
        // so standard output stays the result).
        const files = run.files ?? [];
        if (options.out) {
          for (const path of await saveOutputs(
            ctx,
            files,
            options.out,
            options.workspace,
          )) {
            ctx.io.stderr(`Saved ${path}`);
          }
        } else {
          for (const line of describeOutputs(files)) ctx.io.stderr(line);
        }
        if (options.json) {
          ctx.io.stdout(json(run));
        } else if (run.status === "succeeded") {
          // Text as it is (no quotes), anything else as JSON.
          ctx.io.stdout(
            typeof run.output === "string" ? run.output : json(run.output),
          );
        }
        if (run.status !== "succeeded") {
          throw new Error(`The run failed (${run.id}): ${run.error}`);
        }
      },
    );

/**
 * `scripts publish` and `scripts run`, and their top-level shortcuts
 * `publish` and `run`: the same options and code, so the two forms
 * behave identically. Guides, the site and agent skills use the
 * shortcuts; the long forms stay for the CLI reference and `--help`
 * (docs/product/site.md, "CLI shortcuts").
 */
export const scriptCommands: Command = (program, ctx) => {
  const group =
    program.commands.find((c) => c.name() === "scripts") ??
    program.command("scripts").description("scripts commands");
  // `publish` does the job of creating a script, uploading a version and
  // publishing it, so their generated commands are hidden.
  definePublish(group.command("publish [dir...]"), ctx).description(
    `Upload a folder's script and publish it (--draft to test first; shortcut: ${brand.name} publish)`,
  );
  definePublish(program.command("publish [dir...]"), ctx).description(
    `Short for ${brand.name} scripts publish: upload a folder's script and publish it (--draft to test first)`,
  );
  // `run` starts a run (or a draft's test run) and follows it.
  defineRun(group.command("run <slug>"), ctx).description(
    `Run a script and print its output (--number to test a draft; shortcut: ${brand.name} run)`,
  );
  defineRun(program.command("run <slug>"), ctx).description(
    `Short for ${brand.name} scripts run: run a script and print its output (--number to test a draft)`,
  );
};
