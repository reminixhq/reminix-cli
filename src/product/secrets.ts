import { brand } from "../brand/index.ts";

import type { Command } from "../cli.ts";
import { rawRequest } from "../http.ts";
import { json } from "../output.ts";

/**
 * `reminix secrets set NAME --hosts a,b [--allow-env]` — replaces the
 * generated `secrets set` so the VALUE is read from stdin, never taken as
 * an argument (arguments end up in shell history and process lists):
 *
 *   printf %s "$STRIPE_KEY" | reminix secrets set STRIPE_KEY --hosts api.stripe.com
 *
 * The value is the one for the environment the command acts in (slice
 * 10): the platform's `--environment` / REMINIX_ENVIRONMENT / `reminix
 * environment use`, else the workspace's default — named on stderr.
 */
export const secretCommands: Command = (program, ctx) => {
  const group =
    program.commands.find((c) => c.name() === "secrets") ??
    program.command("secrets").description("secrets commands");
  group
    .command("set <name>")
    .description("Save a secret's value, read from stdin")
    .requiredOption(
      "--hosts <hosts>",
      "the hosts it may be sent to, comma-separated (e.g. api.stripe.com)",
    )
    .option("--allow-env", "let scripts read the value itself (off by default)")
    .option("--workspace <slug>", "act in this workspace for one call")
    .option("--json", "machine-readable output")
    .action(
      async (
        name: string,
        options: {
          hosts: string;
          allowEnv?: boolean;
          workspace?: string;
          json?: boolean;
        },
      ) => {
        // One trailing newline (from echo or a heredoc) is not part of it.
        const value = (await ctx.io.stdin()).replace(/\r?\n$/, "");
        if (!value) {
          throw new Error(
            `Pipe the value in, e.g. printf %s "$VALUE" | ${brand.name} secrets set ${name} --hosts …`,
          );
        }
        const secret = await rawRequest(ctx, {
          method: "PUT",
          path: `/v1/secrets/${encodeURIComponent(name)}`,
          body: {
            value,
            hosts: options.hosts
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean),
            allowEnv: options.allowEnv ?? false,
          },
          workspace: options.workspace,
        });
        ctx.io.stdout(options.json ? json(secret) : `Saved ${name}.`);
      },
    );
};
