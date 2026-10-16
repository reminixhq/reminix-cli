import { brand, productEnvironments, productFeatures } from "./brand/index.ts";
import { DEFAULT_API, unwrap, type Schemas } from "@reminix/sdk";

import { browserLogin, webOriginFor } from "./browser-login.ts";
import type { CliContext, Command } from "./cli.ts";
import { tokenEnvVar } from "./cli.ts";
import {
  configPath,
  environmentEnvVar,
  readConfig,
  writeConfig,
} from "./config.ts";
import { rawRequest } from "./http.ts";
import { json, table } from "./output.ts";
import { approvals } from "./approvals.ts";

async function me(ctx: CliContext): Promise<Schemas["UserMe"]> {
  return unwrap(await ctx.client({ workspace: false }).GET("/user/me"));
}

/**
 * Verifies a token against the API before keeping it (a mistyped token
 * or --api must not stay saved: write, check, roll back), then greets.
 */
async function saveToken(ctx: CliContext, token: string, api?: string) {
  if (!token.startsWith(`pat_${brand.identifier}_`)) {
    throw new Error(`that is not a ${brand.productName} personal access token`);
  }
  const previous = readConfig(ctx.io.homeDir);
  const config = { ...previous, token };
  if (api) config.api = api;
  writeConfig(ctx.io.homeDir, config);
  let user: Awaited<ReturnType<typeof me>>;
  try {
    user = await me(ctx);
  } catch (error) {
    writeConfig(ctx.io.homeDir, previous);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not verify the token (${reason}) — nothing was saved`,
      { cause: error },
    );
  }
  ctx.io.stdout(
    `Logged in. Token stored in ${configPath(ctx.io.homeDir)} (0600).`,
  );
  ctx.io.stdout(
    `Hello ${user.name} <${user.email}> — ${user.workspaces.length} workspace(s).`,
  );
  if (!config.workspace && user.workspaces.length === 1) {
    config.workspace = user.workspaces[0].slug;
    writeConfig(ctx.io.homeDir, config);
    ctx.io.stdout(`Default workspace: ${config.workspace}`);
  } else if (!config.workspace && user.workspaces.length > 1) {
    ctx.io.stdout(`Pick a default: ${brand.name} workspace use <slug>`);
  }
}

const login: Command = (program, ctx) => {
  program
    .command("login")
    .description(
      "Sign in through the browser (or store a personal access token with --token)",
    )
    .option("--token <pat>", "a personal access token (CI, servers)")
    .option("--api <origin>", `API origin (default ${DEFAULT_API})`)
    .option("--web <origin>", "web app origin for the browser sign-in")
    .action(async (options: { token?: string; api?: string; web?: string }) => {
      // A product without personal tokens (brand.json features) has
      // nothing this CLI could sign in with.
      if (!productFeatures.personalTokens) {
        throw new Error(
          `${brand.productName} has no personal access tokens, so this command line cannot sign in.`,
        );
      }
      if (options.token) {
        await saveToken(ctx, options.token, options.api);
        return;
      }
      // Not a person at a terminal (CI, a pipe): read the token from stdin.
      if (!ctx.io.interactive) {
        ctx.io.stderr(
          `Paste a personal access token (Account → API tokens in ${brand.productName}), then Enter:`,
        );
        await saveToken(ctx, (await ctx.io.stdin()).trim(), options.api);
        return;
      }
      // A person: sign in through the browser (./browser-login.ts).
      const api = options.api ?? ctx.settings().api;
      const webOrigin = options.web ?? webOriginFor(api);
      if (!webOrigin) {
        throw new Error(
          `cannot tell the web app's address from ${api} — pass --web <origin>`,
        );
      }
      const token = await browserLogin({
        webOrigin,
        computer: (ctx.io.hostname ?? "this computer").slice(0, 40),
        openUrl: (url) => ctx.io.openUrl?.(url),
        onUrl: (url) =>
          ctx.io.stderr(
            `Opening your browser to sign in. If it does not open, visit:\n  ${url}`,
          ),
      });
      await saveToken(ctx, token, options.api);
    });
};

const logout: Command = (program, ctx) => {
  program
    .command("logout")
    .description("Revoke the stored token and forget it")
    .action(async () => {
      const config = readConfig(ctx.io.homeDir);
      if (config.token) {
        // Revoke it server-side too; an already-invalid token is fine.
        const revoked = await ctx.io
          .fetch(
            new Request(`${ctx.settings().api}/v1/user/token`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${config.token}` },
            }),
          )
          .catch(() => null);
        if (revoked && !revoked.ok && revoked.status !== 401) {
          ctx.io.stderr(
            `Could not revoke the token (HTTP ${revoked.status}) — revoke it under Account → API tokens.`,
          );
        }
      }
      delete config.token;
      writeConfig(ctx.io.homeDir, config);
      ctx.io.stdout("Logged out — the token is revoked and forgotten.");
    });
};

async function printWorkspaces(ctx: CliContext, asJson: boolean) {
  const user = await me(ctx);
  if (asJson) {
    ctx.io.stdout(json(user));
    return;
  }
  const { workspace } = ctx.settings();
  ctx.io.stdout(`${user.name} <${user.email}>`);
  ctx.io.stdout(
    table(
      user.workspaces.map((w) => ({
        slug: w.slug + (w.slug === workspace ? " *" : ""),
        name: w.name,
        role: w.role,
      })),
      ["slug", "name", "role"],
    ),
  );
}

const whoami: Command = (program, ctx) => {
  program
    .command("whoami")
    .description("Who the token acts as, and their workspaces")
    .option("--json", "machine-readable output")
    .action((options: { json?: boolean }) =>
      printWorkspaces(ctx, options.json === true),
    );
};

const workspace: Command = (program, ctx) => {
  const group = program
    .command("workspace")
    .description(
      "Your workspaces (list, use), and the current one's members, webhooks, approvals, usage …",
    );
  group
    .command("list", { isDefault: true })
    .description("List the workspaces the token can act in")
    .option("--json", "machine-readable output")
    .action((options: { json?: boolean }) =>
      printWorkspaces(ctx, options.json === true),
    );
  group
    .command("use <slug>")
    .description("Make <slug> the default workspace for workspace commands")
    .action(async (slug: string) => {
      const user = await me(ctx);
      if (!user.workspaces.some((w) => w.slug === slug)) {
        throw new Error(`you are not a member of '${slug}'`);
      }
      const config = readConfig(ctx.io.homeDir);
      config.workspace = slug;
      writeConfig(ctx.io.homeDir, config);
      ctx.io.stdout(`Default workspace: ${slug}`);
    });
};

/**
 * The default environment (docs/architecture.md "Environments"). Where
 * brand.json declares them the names are known here; where the product's
 * environments are records (resolved by its API), any name is kept and
 * the API refuses an unknown one when it is used.
 */
const environment: Command = (program, ctx) => {
  const group = program
    .command("environment")
    .description("The environment commands act in (list, use, unset)");
  group
    .command("list", { isDefault: true })
    .description("Show the environment commands act in")
    .action(() => {
      const { environment: current, environmentSource } = ctx.settings();
      const from = environmentSource
        ? `(from ${{ flag: "--environment", env: environmentEnvVar(), config: "config" }[environmentSource]})`
        : null;
      const declared = productEnvironments.list;
      if (declared.length > 0) {
        const active = current ?? productEnvironments.default;
        for (const env of declared) {
          ctx.io.stdout(`${env.name}${env.name === active ? " *" : ""}`);
        }
        ctx.io.stdout(from ?? "(the default)");
        return;
      }
      ctx.io.stdout(
        current
          ? `${current} ${from}`
          : "None set — the API acts in the workspace's default.",
      );
    });
  group
    .command("use <name>")
    .description("Make <name> the default environment for commands")
    .action((name: string) => {
      const declared = productEnvironments.list.map((env) => env.name);
      if (declared.length > 0 && !declared.includes(name)) {
        throw new Error(
          `unknown environment '${name}' — ${brand.productName}'s are ${declared.join(", ")}`,
        );
      }
      const config = readConfig(ctx.io.homeDir);
      config.environment = name;
      writeConfig(ctx.io.homeDir, config);
      ctx.io.stdout(`Default environment: ${name}`);
    });
  group
    .command("unset")
    .description(
      "Forget the default environment (the product's default applies)",
    )
    .action(() => {
      const config = readConfig(ctx.io.homeDir);
      delete config.environment;
      writeConfig(ctx.io.homeDir, config);
      ctx.io.stdout("Default environment forgotten.");
    });
};

const api: Command = (program, ctx) => {
  program
    .command("api <method> <path>")
    .description("Call any endpoint as the selected workspace (escape hatch)")
    .option("--data <json>", "JSON request body")
    .option("--workspace <slug>", "act in this workspace for one call")
    .action(
      async (
        method: string,
        path: string,
        options: { data?: string; workspace?: string },
      ) => {
        if (!path.startsWith("/")) {
          throw new Error("usage: api <method> </v1/...> [--data '<json>']");
        }
        const body =
          options.data === undefined
            ? undefined
            : (JSON.parse(options.data) as unknown);
        ctx.io.stdout(
          json(
            await rawRequest(ctx, {
              method: method.toUpperCase(),
              path,
              body,
              workspace: options.workspace,
            }),
          ),
        );
      },
    );
};

const config: Command = (program, ctx) => {
  program
    .command("config")
    .description("Show the effective settings (token masked)")
    .action(() => {
      const settings = ctx.settings();
      ctx.io.stdout(
        json({
          api: settings.api,
          apiDefault: DEFAULT_API,
          token: settings.token ? `${settings.token.slice(0, 12)}…` : null,
          tokenSource: ctx.io.env[tokenEnvVar()]
            ? tokenEnvVar()
            : settings.token
              ? "config"
              : null,
          workspace: settings.workspace ?? null,
          environment: settings.environment ?? null,
          environmentSource:
            settings.environmentSource === "env"
              ? environmentEnvVar()
              : settings.environmentSource,
          file: configPath(ctx.io.homeDir),
        }),
      );
    });
};

export const platformCommands: readonly Command[] = [
  login,
  logout,
  whoami,
  workspace,
  environment,
  api,
  config,
  approvals,
];
