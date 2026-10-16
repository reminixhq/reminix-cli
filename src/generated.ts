import { readFileSync, writeFileSync } from "node:fs";

import { ApiError } from "@reminix/sdk";
import {
  OPERATIONS,
  operationRequest,
  type Operation,
  type OperationField,
} from "./sdk/operations.gen.ts";
import type { Command as Commander } from "commander";

import type { CliContext, Command } from "./cli.ts";
import { coveredOperations, markOperation } from "./covers.ts";
import { json, table } from "./output.ts";

/**
 * A command for EVERY /v1 operation, built from the operation table
 * (@repo/sdk/operations — generated from the OpenAPI document at build,
 * deterministic, never by a model). `audit-events list`,
 * `webhook-endpoints create --url …`: path parameters are positional
 * arguments, query and body fields are flags (`--data '{…}'` for a whole
 * body), every command takes `--json`, writes send an Idempotency-Key, and
 * a confirming operation (DELETE) needs `--yes`. Registered AFTER the
 * hand-written commands and a product's own (./product): a command of the
 * same name there replaces the generated one.
 */
export const generatedCommands: Command = (program, ctx) => {
  const groups = new Set<Commander>();
  // An operation a hand-written command does the job of (./covers.ts)
  // still gets its command, hidden from help and the docs.
  const covered = coveredOperations(program);
  for (const op of OPERATIONS) {
    register(program, ctx, op, groups, covered.has(op.operationId));
  }
  // A group made here describes itself by what it holds: `limits` reads
  // "create, delete, get, list, …" in --help, not "limits commands".
  const help = program.createHelp();
  for (const group of groups) {
    group.description(
      help
        .visibleCommands(group)
        .map((c) => c.name())
        .filter((name) => name !== "help")
        .sort()
        .join(", "),
    );
  }
};

// `environment` is the global --environment (X-Environment): a body field of
// that name goes in --data.
const RESERVED = new Set(["json", "yes", "workspace", "data", "environment"]);

function flag(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** commander's camelCase key for a --kebab-case option. */
function optionKey(name: string): string {
  return flag(name).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function register(
  program: Commander,
  ctx: CliContext,
  op: Operation,
  groups: Set<Commander>,
  hidden: boolean,
) {
  const words = op.cli.command.split(" ");
  const action = words.pop()!;
  let parent = program;
  for (const word of words) {
    let group = parent.commands.find((c) => c.name() === word);
    if (!group) {
      group = parent.command(word);
      groups.add(group);
    }
    parent = group;
  }
  // A hand-written (or product) command of this name wins; it still
  // calls this operation, so the docs link it there.
  const existing = parent.commands.find((c) => c.name() === action);
  if (existing) {
    markOperation(existing, op.operationId);
    return;
  }

  const positional = new Set(op.cli.args);
  const flags = op.fields.filter(
    (field) => !positional.has(field.name) && !RESERVED.has(field.name),
  );
  const command = parent
    .command(action, { hidden })
    .description(op.summary)
    .addHelpText("after", `\n${op.description}`);
  markOperation(command, op.operationId);
  for (const arg of op.cli.args) command.argument(`<${flag(arg)}>`);
  for (const field of flags) {
    const description = [
      field.description ?? `${field.in} field`,
      field.required ? "(required)" : "",
    ]
      .filter(Boolean)
      .join(" ");
    command.option(
      field.type === "boolean"
        ? `--${flag(field.name)}`
        : `--${flag(field.name)} <${field.type === "json" ? "json" : "value"}>`,
      description,
    );
  }
  if (op.hasBody) command.option("--data <json>", "the whole JSON body");
  if (op.rawBody) command.requiredOption("--file <path>", "the file to send");
  if (op.rawResponse) {
    command.requiredOption("--out <path>", "where to save what it answers");
  }
  if (op.workspace) {
    command.option("--workspace <slug>", "act in this workspace for one call");
  }
  if (op.cli.confirm) command.option("--yes", "confirm — it cannot be undone");
  command.option("--json", "machine-readable output");

  command.action(async (...input: unknown[]) => {
    const values = input.slice(0, op.cli.args.length) as string[];
    const options = input[op.cli.args.length] as Record<string, unknown>;
    if (op.cli.confirm && !options.yes) {
      throw new Error(
        `${op.summary} cannot be undone — re-run with --yes to confirm`,
      );
    }
    const args = Object.fromEntries(
      op.cli.args.map((name, i) => [name, values[i]]),
    );
    const result = await call(ctx, op, args, options, flags);
    if (op.rawResponse) {
      writeFileSync(String(options.out), result as Uint8Array);
      ctx.io.stdout(
        options.json === true
          ? json({ saved: String(options.out) })
          : `Saved to ${String(options.out)}`,
      );
      return;
    }
    print(ctx, result, options.json === true);
  });
}

function coerce(field: OperationField, raw: unknown): unknown {
  if (field.type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n))
      throw new Error(`--${flag(field.name)} must be a number`);
    return n;
  }
  if (field.type === "json") {
    try {
      return JSON.parse(String(raw));
    } catch {
      throw new Error(`--${flag(field.name)} must be JSON`);
    }
  }
  return raw;
}

async function call(
  ctx: CliContext,
  op: Operation,
  args: Record<string, string>,
  options: Record<string, unknown>,
  flags: OperationField[],
): Promise<unknown> {
  const { api, token, workspace, environment } = ctx.credentials({
    workspace: op.workspace
      ? ((options.workspace as string | undefined) ?? undefined)
      : false,
  });
  const values = (field: OperationField) =>
    field.in === "path" || op.cli.args.includes(field.name)
      ? args[field.name]
      : options[optionKey(field.name)];

  let whole: Record<string, unknown> = {};
  if (op.hasBody && options.data) {
    try {
      whole = JSON.parse(String(options.data)) as Record<string, unknown>;
    } catch {
      throw new Error("--data must be a JSON object");
    }
  }
  const input: Record<string, unknown> = {};
  for (const field of op.fields) {
    const raw = values(field);
    if (raw === undefined) continue;
    input[field.name] = field.in === "body" ? coerce(field, raw) : raw;
  }
  const missing = flags.filter(
    (field) =>
      field.required &&
      input[field.name] === undefined &&
      (field.in !== "body" || whole[field.name] === undefined),
  );
  if (missing.length > 0) {
    throw new Error(
      `missing ${missing.map((f) => `--${flag(f.name)}`).join(", ")}`,
    );
  }
  const request = operationRequest(op, input, whole);

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };
  if (workspace) headers["x-workspace"] = workspace;
  if (environment) headers["x-environment"] = environment;
  if (request.body) headers["content-type"] = "application/json";
  // A raw body (a file upload) is the file's bytes, as they are.
  const raw = op.rawBody ? readFileSync(String(options.file)) : undefined;
  if (op.rawBody) headers["content-type"] = op.rawBody;
  const response = await ctx.fetch(
    new Request(`${api}/v1${request.path}`, {
      method: request.method,
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      ...(raw ? { body: raw } : {}),
    }),
  );
  if (op.rawResponse && response.ok) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = (data as { error?: Record<string, string> } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "internal_error",
      error?.message ?? `HTTP ${response.status}`,
      error?.requestId,
    );
  }
  return data;
}

function scalarColumns(rows: Record<string, unknown>[]): string[] {
  const first = rows[0] ?? {};
  return Object.keys(first).filter(
    (key) => first[key] === null || typeof first[key] !== "object",
  );
}

/** Readable by default; exactly the API's JSON with --json. */
function print(ctx: CliContext, data: unknown, asJson: boolean) {
  if (asJson) {
    if (data !== null) ctx.io.stdout(json(data));
    return;
  }
  if (data === null) {
    ctx.io.stdout("Done.");
    return;
  }
  const page = data as { items?: unknown; nextCursor?: unknown };
  if (Array.isArray(page.items)) {
    const rows = page.items as Record<string, unknown>[];
    ctx.io.stdout(
      rows.length === 0 ? "No results." : table(rows, scalarColumns(rows)),
    );
    if (typeof page.nextCursor === "string") {
      ctx.io.stdout(`More: --cursor ${page.nextCursor}`);
    }
    return;
  }
  if (typeof data === "object") {
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      ctx.io.stdout(
        `${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`,
      );
    }
    return;
  }
  ctx.io.stdout(String(data));
}
