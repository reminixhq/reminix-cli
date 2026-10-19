import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { brand } from "../brand/index.ts";
import { uploadFile, type Schemas } from "@reminix/sdk";

import type { CliContext, Command } from "../cli.ts";
import { json } from "../output.ts";

/**
 * Files (docs/product/roadmap.md slice 8): `files upload <path>` and
 * `files download <id>` — the two raw-bytes operations, which the
 * generated commands can't do — and the helpers `scripts run --file` and
 * `--out` use.
 */

type File = Schemas["File"];

/** Uploads a file from disk; its id is what a run's file input takes. */
export async function uploadPath(
  ctx: CliContext,
  path: string,
  workspace?: string,
): Promise<File> {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return uploadFile(ctx.client({ workspace }), {
    // No type: the API takes it from the name (one table for every client).
    name: basename(path),
    data: new Uint8Array(data),
  });
}

/** A file's bytes (with the key: no link needed). */
export async function downloadBytes(
  ctx: CliContext,
  id: string,
  workspace?: string,
): Promise<Uint8Array> {
  const result = await ctx
    .client({ workspace })
    .GET("/files/{fileId}/content", {
      params: { path: { fileId: id } },
      parseAs: "arrayBuffer",
    });
  if (!result.response.ok || !result.data) {
    const body = result.error as { error?: { message?: string } } | undefined;
    throw new Error(
      body?.error?.message ??
        `Downloading ${id} failed (${result.response.status})`,
    );
  }
  return new Uint8Array(result.data as ArrayBuffer);
}

/**
 * Where a run's output goes under `dir`: its name, folders kept — never
 * outside `dir`.
 */
export function outputPath(dir: string, name: string): string {
  const root = resolve(dir);
  const path = resolve(root, name);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`${name}: not a path inside ${dir}`);
  }
  return path;
}

/** Saves a run's written files under `dir`; returns where each went. */
export async function saveOutputs(
  ctx: CliContext,
  files: File[],
  dir: string,
  workspace?: string,
): Promise<string[]> {
  const saved: string[] = [];
  for (const file of files.filter((f) => f.direction === "out")) {
    const path = outputPath(dir, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await downloadBytes(ctx, file.id, workspace));
    saved.push(path);
  }
  return saved;
}

export const fileCommands: Command = (program, ctx) => {
  const group =
    program.commands.find((c) => c.name() === "files") ??
    program.command("files").description("files commands");

  group
    .command("upload <path>")
    .description("Upload a file to give a run, and print its id")
    .option("--workspace <slug>", "act in this workspace for one call")
    .option("--json", "print the whole file, not just its id")
    .action(
      async (path: string, options: { workspace?: string; json?: boolean }) => {
        const file = await uploadPath(ctx, path, options.workspace);
        ctx.io.stdout(options.json ? json(file) : file.id);
      },
    );

  group
    .command("download <file-id>")
    .description("Save a file that a run took in or wrote")
    .option("--out <path>", "where to save it")
    .option("--workspace <slug>", "act in this workspace for one call")
    .action(
      async (id: string, options: { out?: string; workspace?: string }) => {
        const client = ctx.client({ workspace: options.workspace });
        const meta = await client.GET("/files/{fileId}", {
          params: { path: { fileId: id } },
        });
        if (!meta.data) {
          throw new Error(
            (meta.error as { error?: { message?: string } } | undefined)?.error
              ?.message ?? `No such file: ${id}`,
          );
        }
        const path =
          options.out ?? join(".", basename(meta.data.name) || meta.data.id);
        mkdirSync(dirname(resolve(path)), { recursive: true });
        writeFileSync(path, await downloadBytes(ctx, id, options.workspace));
        ctx.io.stdout(`Saved ${path}`);
      },
    );
};

/** For `scripts run` without --out: what it wrote, and how to get it. */
export function describeOutputs(files: File[]): string[] {
  return files
    .filter((f) => f.direction === "out")
    .map(
      (f) =>
        `Wrote ${f.name}: ${f.downloadUrl ?? `${brand.name} files download ${f.id}`}`,
    );
}
