import { brand } from "./brand/index.ts";
import {
  ApiError,
  createClient,
  keysFrom,
  withRetries,
  type Client,
} from "@reminix/sdk";
import { Command as Commander, CommanderError } from "commander";

import { platformCommands } from "./commands.ts";
import { environmentEnvVar, resolveSettings, type Settings } from "./config.ts";
import { generatedCommands } from "./generated.ts";
import { productCommands } from "./product/index.ts";

/**
 * The product's command-line client — a person talking to the public API
 * with a personal access token (docs/architecture.md "Personal access
 * tokens"). commander parses; @repo/sdk (generated from the /v1 routes)
 * makes the calls. The binary is named after the product (brand.json
 * `name`); everything it prints reads identity from @repo/brand.
 *
 * A command is a function that registers itself on the program, so a
 * product adds its own in ./product (fork-owned, registered LAST) without
 * touching this file. `run()` takes its whole environment as an argument,
 * so tests drive it with a fake fetch and a temp home directory.
 *
 * Every answer names its environment (docs/architecture.md
 * "Environments"): where the API says which one a command acted in (the
 * X-Environment response header), `run()` adds an `Environment: <name>`
 * line on stderr — stdout, `--json` included, stays exactly the output.
 */
export type Io = {
  env: Record<string, string | undefined>;
  homeDir: string;
  fetch: typeof fetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Reads all of stdin (used by `login` when no --token is given). */
  stdin: () => Promise<string>;
  /** A person at a terminal (stdin is a TTY): `login` opens the browser. */
  interactive?: boolean;
  /** This computer's name, for the login token ("CLI on <hostname>"). */
  hostname?: string;
  /** Opens a URL in the browser (best effort). */
  openUrl?: (url: string) => void;
};

/** What every command gets besides its parsed options. */
export type CliContext = {
  io: Io;
  /** Effective settings: flags over shell variables over ~/.config/<name>/config.json over defaults. */
  settings: () => Settings;
  /**
   * The stored credentials, checked: throws "not logged in" without a
   * token, and "no workspace selected" when one is needed and neither
   * `workspace` nor the default names one. `workspace: false` = a route
   * that takes none (/v1/user/*).
   */
  credentials: (options?: { workspace?: string | false }) => {
    api: string;
    token: string;
    workspace: string | undefined;
    /** Sent as X-Environment when set (`--environment` / <NAME>_ENVIRONMENT / config). */
    environment: string | undefined;
  };
  /** A typed API client over those credentials (see @repo/sdk). */
  client: (options?: { workspace?: string | false }) => Client;
  /**
   * `io.fetch`, noting the environment each answer names — a command that
   * calls the API without `client()` uses this, so its output names it too.
   * Every write gets an Idempotency-Key (from `--idempotency-key` when
   * given, one per write otherwise) and a failed attempt is retried with
   * the same key (@repo/sdk withRetries), so a command never does a write
   * twice — nor does running it again with the same `--idempotency-key`.
   */
  fetch: (request: Request) => Promise<Response>;
};

/** Registers one or more commands: `program.command("x").option(…).action(…)`. */
export type Command = (program: Commander, ctx: CliContext) => void;

export const commands: readonly Command[] = [
  ...platformCommands,
  ...productCommands,
  // A command for every /v1 operation, from the operation table — last,
  // so a hand-written command of the same name wins (./generated.ts).
  generatedCommands,
];

/** The environment variable that overrides the stored token (PLATFORM_TOKEN, LIMITRY_TOKEN, …). */
export function tokenEnvVar(): string {
  return `${brand.identifier.toUpperCase()}_TOKEN`;
}

export function createProgram(io: Io): Commander {
  return build(io).program;
}

function build(io: Io) {
  // The environment the API last said it acted in (X-Environment).
  let actedIn: string | null = null;
  // Built on the first request, once the flags are parsed.
  let sending: ((request: Request) => Promise<Response>) | undefined;
  const program = new Commander()
    .name(brand.name)
    .description(`${brand.productName} command line`)
    .version(process.env.CLI_VERSION ?? "0.0.0-dev")
    .addHelpText(
      "after",
      `\nToken: \`${brand.name} login\` stores it in ~/.config/${brand.name}/; ${tokenEnvVar()} overrides.` +
        `\nEnvironment: --environment, else ${environmentEnvVar()}, else \`${brand.name} environment use\`, else the default.`,
    )
    .option(
      "--environment <name>",
      "act in this environment (where the product has them)",
    )
    .option(
      "--idempotency-key <key>",
      "run again with the same key and its writes happen once",
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text.replace(/\n$/, "")),
      writeErr: (text) => io.stderr(text.replace(/\n$/, "")),
    })
    .showHelpAfterError();
  const ctx: CliContext = {
    io,
    settings: () =>
      resolveSettings(io.env, io.homeDir, {
        environment: program.opts<{ environment?: string }>().environment,
      }),
    credentials: (options = {}) => {
      const settings = ctx.settings();
      if (!settings.token) {
        throw new Error(
          `not logged in — run \`${brand.name} login\` or set ${tokenEnvVar()}`,
        );
      }
      // A workspace API key IS its workspace (the API ignores X-Workspace
      // for one): it needs no workspace, and naming one is a mistake to
      // say out loud, not a silent switch. A personal token is a person,
      // who may belong to several, so it names one.
      if (!settings.token.startsWith("pat_")) {
        if (typeof options.workspace === "string") {
          throw new Error(
            "an API key acts only in its own workspace: leave out --workspace (or use a personal token)",
          );
        }
        return {
          api: settings.api,
          token: settings.token,
          workspace: undefined,
          environment: settings.environment,
        };
      }
      const workspace =
        options.workspace === false
          ? undefined
          : (options.workspace ?? settings.workspace);
      if (options.workspace !== false && !workspace) {
        throw new Error(
          `no workspace selected — \`${brand.name} workspace use <slug>\` or pass --workspace <slug>`,
        );
      }
      return {
        api: settings.api,
        token: settings.token,
        workspace,
        environment: settings.environment,
      };
    },
    client: (options) =>
      // ctx.fetch keys and retries; the client must not do it again.
      createClient({
        ...ctx.credentials(options),
        fetch: ctx.fetch,
        maxRetries: 0,
      }),
    fetch: (request) => {
      sending ??= withRetries(
        async (attempt) => {
          const response = await io.fetch(attempt);
          actedIn = response.headers.get("x-environment") ?? actedIn;
          return response;
        },
        {
          key: keysFrom(
            program.opts<{ idempotencyKey?: string }>().idempotencyKey,
          ),
        },
      );
      return sending(request);
    },
  };
  for (const register of commands) register(program, ctx);
  return { program, actedIn: () => actedIn };
}

export async function run(argv: string[], io: Io): Promise<number> {
  const { program, actedIn } = build(io);
  try {
    await program.parseAsync(argv, { from: "user" });
    const environment = actedIn();
    if (environment) io.stderr(`Environment: ${environment}`);
    return 0;
  } catch (error) {
    const environment = actedIn();
    // Help and version also end here (exitOverride): exit code 0.
    if (error instanceof CommanderError) return error.exitCode;
    // With --json, failures are JSON too (stderr): scripts and agents
    // parse one shape — the API's own error envelope.
    if (argv.includes("--json")) {
      io.stderr(
        JSON.stringify({
          error:
            error instanceof ApiError
              ? {
                  code: error.code,
                  message: error.message,
                  status: error.status,
                  ...(error.requestId ? { requestId: error.requestId } : {}),
                }
              : { code: "cli_error", message: (error as Error).message },
          ...(environment ? { environment } : {}),
        }),
      );
      return 1;
    }
    if (error instanceof ApiError) {
      const requestId = error.requestId ? ` [request ${error.requestId}]` : "";
      io.stderr(`${brand.name}: ${error.message} (${error.code})${requestId}`);
    } else {
      io.stderr(`${brand.name}: ${(error as Error).message}`);
    }
    if (environment) io.stderr(`Environment: ${environment}`);
    return 1;
  }
}
