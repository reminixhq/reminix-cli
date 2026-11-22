import { readFileSync, writeFileSync } from "node:fs";

import { apiErrorFrom } from "@reminix/sdk";
import {
  OPERATIONS,
  operationRequest,
  type Operation,
  type OperationField,
} from "./sdk/operations.gen.ts";
import type { Command as Commander } from "commander";

import type { CliContext, Command } from "./cli.ts";
import { coveredOperations, markOperation } from "./covers.ts";
import { UsageError } from "./errors.ts";
import {
  fieldFlag,
  kebab as flag,
  optionKey,
  type FieldFlag,
} from "./flags.ts";
import { json, table } from "./output.ts";

/**
 * A command for EVERY /v1 operation, built from the operation table
 * (@repo/typescript-sdk/operations — generated from the OpenAPI document at build,
 * deterministic, never by a model). `audit-events list`,
 * `webhook-endpoints create --url …`: path parameters are positional
 * arguments, query and body fields are flags (./flags.ts: a list is a
 * repeatable flag, a boolean `--x` / `--no-x`, a nullable field
 * `--clear-<field>`; `--data '{…}'` for a whole body), every command
 * takes `--json`, a list takes `--all` for every page, writes send an
 * Idempotency-Key, and a confirming operation (DELETE) needs `--yes`. Registered AFTER the
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

/** A field and its flag (./flags.ts). */
type Flagged = { field: OperationField; spec: FieldFlag };

/** A list's values: repeated and comma-separated alike. */
const collect = (value: string, previous: string[] | undefined) => [
  ...(previous ?? []),
  ...value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
];

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
  const fields = op.fields.filter(
    (field) => !positional.has(field.name) && !RESERVED.has(field.name),
  );
  const names = new Set(fields.map((field) => flag(field.name)));
  const flags: Flagged[] = fields.map((field) => ({
    field,
    spec: fieldFlag(field, names),
  }));
  const command = parent
    .command(action, { hidden })
    .description(op.summary)
    .addHelpText("after", `\n${op.description}`);
  markOperation(command, op.operationId);
  for (const arg of op.cli.args) command.argument(`<${flag(arg)}>`);
  for (const { field, spec } of flags) {
    const description = [
      field.description ?? `${field.in} field`,
      spec.kind === "list" ? "Repeat it for each value." : "",
      field.required ? "(required)" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (spec.kind === "boolean") {
      command.option(`--${spec.name}`, description);
      command.option(`--no-${spec.name}`, `turn --${spec.name} off`);
    } else if (spec.kind === "list") {
      command.option(`--${spec.name} <value>`, description, collect);
    } else {
      command.option(
        `--${spec.name} <${spec.kind === "json" ? "json" : "value"}>`,
        description,
      );
    }
    if (spec.clear) {
      command.option(`--clear-${spec.clear}`, `set ${field.name} to null`);
    }
  }
  if (op.paginated) {
    command.option("--all", "every page, not just the first");
  }
  if (op.hasBody) command.option("--data <json>", "the whole JSON body");
  if (op.rawBody) command.requiredOption("--file <path>", "the file to send");
  if (op.rawResponse) {
    command.requiredOption("--out <path>", "where to save what it answers");
  }
  if (op.workspace) {
    command.option("--workspace <slug>", "act in this workspace for one call");
  }
  if (op.cli.confirm)
    command.option("--yes", "confirm an operation that cannot be undone");
  command.option("--json", "machine-readable output");

  command.action(async (...input: unknown[]) => {
    const values = input.slice(0, op.cli.args.length) as string[];
    const options = input[op.cli.args.length] as Record<string, unknown>;
    if (op.cli.confirm && !options.yes) {
      throw new UsageError(
        `${op.summary} cannot be undone. Run it again with --yes to confirm.`,
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

function number(name: string, raw: unknown): number {
  const n = Number(raw);
  if (raw === "" || Number.isNaN(n)) {
    throw new UsageError(`--${name} must be a number`);
  }
  return n;
}

function coerce({ field, spec }: Flagged, raw: unknown): unknown {
  if (spec.kind === "list") {
    const values = raw as string[];
    return spec.numbers ? values.map((v) => number(spec.name, v)) : values;
  }
  if (spec.kind === "boolean") return raw === true;
  if (field.type === "number") return number(spec.name, raw);
  if (field.type === "json") {
    try {
      return JSON.parse(String(raw));
    } catch {
      throw new UsageError(`--${spec.name} must be JSON`);
    }
  }
  return raw;
}

async function call(
  ctx: CliContext,
  op: Operation,
  args: Record<string, string>,
  options: Record<string, unknown>,
  flags: Flagged[],
): Promise<unknown> {
  let whole: Record<string, unknown> = {};
  if (op.hasBody && options.data) {
    try {
      whole = JSON.parse(String(options.data)) as Record<string, unknown>;
    } catch {
      throw new UsageError("--data must be a JSON object");
    }
  }
  // Positional arguments and path fields as typed; flags coerced.
  const input: Record<string, unknown> = {};
  for (const field of op.fields) {
    if (field.in === "path" || op.cli.args.includes(field.name)) {
      if (args[field.name] !== undefined) input[field.name] = args[field.name];
    }
  }
  for (const flagged of flags) {
    const { field, spec } = flagged;
    const raw = options[optionKey(spec.name)];
    const clear = spec.clear && options[optionKey(`clear-${spec.clear}`)];
    if (clear && raw !== undefined) {
      throw new UsageError(
        `pass --${spec.name} or --clear-${spec.clear}, not both`,
      );
    }
    if (clear) input[field.name] = null;
    else if (raw !== undefined) {
      input[field.name] =
        field.in === "body" || spec.kind !== "value"
          ? coerce(flagged, raw)
          : raw;
    }
  }
  const missing = flags.filter(
    ({ field }) =>
      field.required &&
      input[field.name] === undefined &&
      (field.in !== "body" || whole[field.name] === undefined),
  );
  if (missing.length > 0) {
    throw new UsageError(
      `missing ${missing.map(({ spec }) => `--${spec.name}`).join(", ")}`,
    );
  }
  const problem = variantProblem(op, input, whole);
  if (problem) throw new UsageError(problem);
  const credentials = ctx.credentials({
    workspace: op.workspace
      ? ((options.workspace as string | undefined) ?? undefined)
      : false,
  });
  if (op.paginated && options.all === true) {
    // Every page: the same call with each page's nextCursor, the rows
    // together in one answer of the same shape.
    const paged = op.fields.some(
      (f) => f.in === "query" && f.name === "cursor",
    );
    const items: unknown[] = [];
    let cursor = input.cursor;
    for (;;) {
      const page = (await send(
        ctx,
        op,
        credentials,
        operationRequest(op, { ...input, cursor }, whole),
        options,
      )) as { items: unknown[]; nextCursor: string | null };
      items.push(...page.items);
      if (!paged || typeof page.nextCursor !== "string") break;
      cursor = page.nextCursor;
    }
    return { items, nextCursor: null };
  }
  return send(
    ctx,
    op,
    credentials,
    operationRequest(op, input, whole),
    options,
  );
}

/** Sends one request of the operation; its data, or throws its APIError. */
async function send(
  ctx: CliContext,
  op: Operation,
  credentials: ReturnType<CliContext["credentials"]>,
  request: ReturnType<typeof operationRequest>,
  options: Record<string, unknown>,
): Promise<unknown> {
  const { baseURL, token, workspace, environment } = credentials;

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
    new Request(`${baseURL}/v1${request.path}`, {
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
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) throw new Error("the API's answer is not JSON");
  }
  // The SDK's errors, a class per status (@repo/typescript-sdk).
  if (!response.ok) throw apiErrorFrom(data, response);
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
      ctx.io.stdout(
        `More: --cursor ${page.nextCursor}, or --all for every page`,
      );
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

/**
 * An either/or body (`op.variants`): what's wrong with the flags given
 * for the chosen value, or undefined when they're enough.
 */
export function variantProblem(
  op: Pick<Operation, "variants">,
  input: Record<string, unknown>,
  whole: Record<string, unknown>,
): string | undefined {
  if (!op.variants) return undefined;
  const key = op.variants.field;
  const chosen = String(input[key] ?? whole[key]);
  const needs = op.variants.required[chosen];
  if (!needs) {
    return `--${flag(key)} must be one of ${Object.keys(op.variants.required).join(", ")}`;
  }
  const absent = needs.filter(
    (name) => input[name] === undefined && whole[name] === undefined,
  );
  return absent.length > 0
    ? `missing ${absent.map((name) => `--${flag(name)}`).join(", ")} (needed with --${flag(key)} ${chosen})`
    : undefined;
}
