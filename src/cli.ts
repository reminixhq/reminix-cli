import { brand } from "./brand/index.ts";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  connectionErrorFrom,
  createClient,
  keysFrom,
  withRetries,
  type Client,
} from "@reminix/sdk";
import { Command as Commander, CommanderError } from "commander";

import { platformCommands } from "./commands.ts";
import {
  baseURLEnvVar,
  environmentEnvVar,
  resolveSettings,
  type Settings,
} from "./config.ts";
import { EXIT, NotLoggedInError } from "./errors.ts";
import { generatedCommands } from "./generated.ts";
import * as product from "./product/index.ts";
import { productCommands } from "./product/index.ts";

/**
 * The product's command-line client — a person talking to the public API
 * with a personal access token (docs/architecture.md "Personal access
 * tokens"). commander parses; @repo/typescript-sdk (generated from the /v1 routes)
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
 *
 * Exit codes (./errors.ts): 0 success, 1 a failure, 2 wrong usage, 4
 * not logged in or a refused credential (401).
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
    /** The API's origin (`--base-url` / <NAME>_BASE_URL / config). */
    baseURL: string;
    token: string;
    workspace: string | undefined;
    /** Sent as X-Environment when set (`--environment` / <NAME>_ENVIRONMENT / config). */
    environment: string | undefined;
  };
  /** A typed API client over those credentials (see @repo/typescript-sdk). */
  client: (options?: { workspace?: string | false }) => Client;
  /**
   * `io.fetch`, noting the environment each answer names — a command that
   * calls the API without `client()` uses this, so its output names it too.
   * Every write gets an Idempotency-Key (from `--idempotency-key` when
   * given, one per write otherwise) and a failed attempt is retried with
   * the same key (@repo/typescript-sdk withRetries), so a command never does a write
   * twice — nor does running it again with the same `--idempotency-key`.
   * Network failures are the SDK's APIConnectionError, and every request
   * names the CLI in its User-Agent (`<name>-cli/<version>`).
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

const VERSION = process.env.CLI_VERSION ?? "0.0.0-dev";

function build(io: Io) {
  // The environment the API last said it acted in (X-Environment).
  let actedIn: string | null = null;
  // Built on the first request, once the flags are parsed.
  let sending: ((request: Request) => Promise<Response>) | undefined;
  const program = new Commander()
    .name(brand.name)
    .description(`The ${brand.productName} CLI`)
    .version(VERSION)
    .addHelpText(
      "after",
      `\nToken: \`${brand.name} login\` stores it in ~/.config/${brand.name}/; ${tokenEnvVar()} overrides.` +
        `\nEnvironment: --environment, else ${environmentEnvVar()}, else \`${brand.name} environment use\`, else the default.` +
        `\nAPI: --base-url, else ${baseURLEnvVar()}, else the one \`${brand.name} login --base-url\` saved.` +
        "\nExit codes: 0 success, 1 failure, 2 wrong usage, 4 not logged in.",
    )
    .option("--base-url <url>", "the API's origin, without /v1")
    .option("--environment <name>", "act in this environment")
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
      resolveSettings(
        io.env,
        io.homeDir,
        program.opts<{ environment?: string; baseUrl?: string }>(),
      ),
    credentials: (options = {}) => {
      const settings = ctx.settings();
      if (!settings.token) {
        throw new NotLoggedInError(
          `not logged in. Run \`${brand.name} login\` or set ${tokenEnvVar()}.`,
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
          baseURL: settings.baseURL,
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
          `no workspace selected. Run \`${brand.name} workspace use <slug>\` or pass --workspace <slug>.`,
        );
      }
      return {
        baseURL: settings.baseURL,
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
    fetch: async (request) => {
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
      const headers = new Headers(request.headers);
      headers.set("user-agent", `${brand.name}-cli/${VERSION}`);
      const named = new Request(request, { headers });
      try {
        return await sending(named);
      } catch (error) {
        throw connectionErrorFrom(error, request.signal);
      }
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
    return EXIT.ok;
  } catch (error) {
    const environment = actedIn();
    // Help and version also end here (exitOverride) with 0; any other
    // error commander finds (an unknown flag, a missing argument, a
    // group without its command) is wrong usage.
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    const code = exitCode(error);
    // With --json, failures are JSON too (stderr): scripts and agents
    // parse one shape — the API's own error envelope.
    if (argv.includes("--json")) {
      io.stderr(
        JSON.stringify({
          error:
            error instanceof APIError
              ? {
                  code: error.code,
                  message: error.message,
                  status: error.status,
                  ...(error.requestId ? { requestId: error.requestId } : {}),
                  ...(error.docs ? { docs: error.docs } : {}),
                  ...(error.details ? { details: error.details } : {}),
                }
              : {
                  code:
                    code === EXIT.usage
                      ? "usage_error"
                      : code === EXIT.auth
                        ? "not_logged_in"
                        : "cli_error",
                  message: (error as Error).message,
                },
          ...(environment ? { environment } : {}),
        }),
      );
      return code;
    }
    if (error instanceof APIError) {
      const requestId = error.requestId ? ` [request ${error.requestId}]` : "";
      io.stderr(`${brand.name}: ${error.message} (${error.code})${requestId}`);
      for (const detail of error.details ?? []) {
        io.stderr(
          `  ${detail.path ? `${detail.path}: ` : ""}${detail.message}`,
        );
      }
      const hint = scopeHint(error);
      if (hint) io.stderr(hint);
      if (error.docs) io.stderr(`See ${error.docs}`);
    } else {
      // A network failure names what failed (its cause).
      const cause =
        error instanceof APIConnectionError && error.cause instanceof Error
          ? ` (${error.cause.message})`
          : "";
      io.stderr(`${brand.name}: ${(error as Error).message}${cause}`);
    }
    if (environment) io.stderr(`Environment: ${environment}`);
    return code;
  }
}

/** The exit code for a failure (./errors.ts). */
function exitCode(error: unknown): number {
  // A 401, also behind a command's own message (login's "could not verify").
  if (
    error instanceof AuthenticationError ||
    (error as Error | null)?.cause instanceof AuthenticationError
  ) {
    return EXIT.auth;
  }
  const own = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof own === "number" && !(error instanceof APIError)
    ? own
    : EXIT.failure;
}

/**
 * How to fix a refusal for a missing permission (owner, 2026-11-20: a
 * new person's `publish` failed after a Read only sign-in, and nothing
 * said what to do). A product's own wording first, from an optional
 * `productErrorHint(error)` in ./product/index.ts, naming its quick
 * choice ("…choose Publish and run scripts."); else the general one.
 */
export function scopeHint(error: APIError): string | null {
  const own = Reflect.get(product, "productErrorHint") as
    ((error: APIError) => string | null | undefined) | undefined;
  const mine = own?.(error);
  if (mine) return mine;
  const scope = /not granted the ([\w.:-]+) scope/.exec(error.message)?.[1];
  if (error.code !== "forbidden" || !scope) return null;
  return `Sign in again with \`${brand.name} login\` and choose access that includes ${scope}.`;
}
