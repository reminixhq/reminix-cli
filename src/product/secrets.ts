import { brand } from "../brand/index.ts";

import type { Command } from "../cli.ts";
import { covers } from "../covers.ts";
import { rawRequest } from "../http.ts";
import { json } from "../output.ts";

/**
 * `reminix secrets set NAME --hosts a,b [--allow-env-var]` — replaces the
 * generated `secrets set` (secretValues.set) so the VALUE is read from
 * stdin, never taken as an argument (arguments end up in shell history
 * and process lists):
 *
 *   printf %s "$STRIPE_KEY" | reminix secrets set STRIPE_KEY --hosts api.stripe.com
 *
 * The value is the one for the environment the command acts in (slice
 * 10): the platform's `--environment` / REMINIX_ENVIRONMENT / `reminix
 * environment use`, else the workspace's default. It is saved at
 * `PUT /v1/secrets/{name}/values/{environment}`. `--allow-env-var` and
 * `--no-allow-env-var` apply to the secret in every environment
 * (`PATCH /v1/secrets/{name}`), and leave it as it was when not given.
 */
export const secretCommands: Command = (program, ctx) => {
  const group =
    program.commands.find((c) => c.name() === "secrets") ??
    program.command("secrets").description("Save, read and delete secrets");
  covers(
    group
      .command("set <name>")
      .description("Save a secret's value, read from stdin")
      .requiredOption(
        "--hosts <hosts>",
        "the hosts it may be sent to, comma-separated (e.g. api.stripe.com)",
      )
      .option(
        "--allow-env-var",
        "let scripts read the value as an environment variable (off for a new secret)",
      )
      .option(
        "--no-allow-env-var",
        "attach the value to requests only, never as an environment variable",
      )
      .option("--workspace <slug>", "act in this workspace for one call")
      .option("--json", "machine-readable output"),
    "secretValues.set",
    "secrets.update",
  ).action(
    async (
      name: string,
      options: {
        hosts: string;
        allowEnvVar?: boolean;
        workspace?: string;
        json?: boolean;
      },
    ) => {
      const value = await readValue(ctx, name);
      const environment = await environmentOf(ctx, options.workspace);
      let secret = await saveValue(ctx, name, environment, value, options);
      if (options.allowEnvVar !== undefined) {
        secret = await rawRequest(ctx, {
          method: "PATCH",
          path: `/v1/secrets/${encodeURIComponent(name)}`,
          body: { allowEnvVar: options.allowEnvVar },
          workspace: options.workspace,
        });
      }
      ctx.io.stdout(
        options.json ? json(secret) : `Saved ${name} in ${environment}.`,
      );
    },
  );
};

/** The value, from stdin: never an argument. */
async function readValue(
  ctx: Parameters<Command>[1],
  name: string,
): Promise<string> {
  // One trailing newline (from echo or a heredoc) is not part of it.
  const value = (await ctx.io.stdin()).replace(/\r?\n$/, "");
  if (!value) {
    throw new Error(
      `Pipe the value in, e.g. printf %s "$VALUE" | ${brand.name} secrets set ${name} --hosts …`,
    );
  }
  return value;
}

/** Saves one environment's value (PUT /v1/secrets/{name}/values/{environment}). */
async function saveValue(
  ctx: Parameters<Command>[1],
  name: string,
  environment: string,
  value: string,
  options: { hosts: string; workspace?: string },
): Promise<unknown> {
  return rawRequest(ctx, {
    method: "PUT",
    path: `/v1/secrets/${encodeURIComponent(name)}/values/${encodeURIComponent(environment)}`,
    body: {
      value,
      hosts: options.hosts
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
    },
    workspace: options.workspace,
  });
}

/** The environment the command acts in: the one chosen, else the default. */
async function environmentOf(
  ctx: Parameters<Command>[1],
  workspace: string | undefined,
): Promise<string> {
  const chosen = ctx.credentials({ workspace }).environment;
  if (chosen) return chosen;
  const environments = (await rawRequest(ctx, {
    method: "GET",
    path: "/v1/environments?limit=100",
    workspace,
  })) as { items: { name: string; isDefault: boolean }[] };
  const fallback = environments.items.find((e) => e.isDefault);
  if (!fallback) throw new Error("This workspace has no default environment.");
  return fallback.name;
}
