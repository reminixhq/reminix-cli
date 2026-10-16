import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Command } from "./cli.ts";
import { rawRequest } from "./http.ts";
import { json } from "./output.ts";

/**
 * `workspace approval-requests redeem` — hand-written over the generated command
 * of the same name, because what it returns is a SECRET (an API key, a
 * webhook signing secret): it goes into a file, never to the terminal,
 * so an agent driving the CLI never sees it (docs/architecture.md
 * "Approvals"). `--wait` first waits for the person's decision. The flag
 * is `--write-env`, not `--env-file`: Node (26) claims `--env-file`
 * itself, even after the script name.
 */
type Approval = {
  id: string;
  status: string;
  approveUrl: string;
  summary: string;
  secret: { name: string; envVar: string } | null;
};

const POLL_MS = 3000;

/** Sets NAME=value in an env file: replaces the line, or appends one. */
export function writeEnvVar(path: string, name: string, value: string) {
  const existed = existsSync(path);
  const lines = existed ? readFileSync(path, "utf8").split("\n") : [];
  const line = `${name}=${value}`;
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  writeFileSync(path, lines.join("\n"));
  if (!existed) chmodSync(path, 0o600);
}

export const approvals: Command = (program, ctx) => {
  // Under the `workspace` group with the generated approval commands
  // (`workspace approval-requests create` …), registered before them.
  const workspace =
    program.commands.find((c) => c.name() === "workspace") ??
    program.command("workspace");
  const group = workspace
    .command("approval-requests")
    .description("approval-requests commands");
  group
    .command("redeem <request-id>")
    .description(
      "Collect an approved secret once, into an env file (never printed)",
    )
    .requiredOption(
      "--write-env <path>",
      "the file to write it to, e.g. .env (it is never printed)",
    )
    .option("--env-var <name>", "the variable name (default: the action's)")
    .option("--wait", "wait for the person's decision first")
    .option("--timeout <minutes>", "how long --wait waits", "15")
    .option("--workspace <slug>", "act in this workspace for one call")
    .option("--json", "machine-readable output")
    .action(
      async (
        id: string,
        options: {
          writeEnv: string;
          envVar?: string;
          wait?: boolean;
          timeout: string;
          workspace?: string;
          json?: boolean;
        },
      ) => {
        const call = (method: string, path: string) =>
          rawRequest(ctx, { method, path, workspace: options.workspace });
        let request = (await call(
          "GET",
          `/v1/workspace/approval-requests/${encodeURIComponent(id)}`,
        )) as Approval;
        if (request.status === "pending" && options.wait) {
          if (!options.json) {
            ctx.io.stderr(
              `Waiting for a person to approve: ${request.summary}\n  ${request.approveUrl}`,
            );
          }
          const deadline = Date.now() + Number(options.timeout) * 60_000;
          while (request.status === "pending" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            request = (await call(
              "GET",
              `/v1/workspace/approval-requests/${encodeURIComponent(id)}`,
            )) as Approval;
          }
        }
        if (request.status !== "approved") {
          throw new Error(
            request.status === "pending"
              ? `Not approved yet — ask a person to approve it: ${request.approveUrl}`
              : `This request is ${request.status}; nothing to collect.`,
          );
        }
        const redeemed = (await call(
          "POST",
          `/v1/workspace/approval-requests/${encodeURIComponent(id)}/redeem`,
        )) as {
          request: Approval;
          secret: string | null;
          envVar: string | null;
        };
        const name = options.envVar ?? redeemed.envVar;
        if (redeemed.secret && name) {
          writeEnvVar(options.writeEnv, name, redeemed.secret);
        }
        const written =
          redeemed.secret && name
            ? { file: options.writeEnv, envVar: name }
            : null;
        if (options.json) {
          ctx.io.stdout(json({ request: redeemed.request, written }));
        } else {
          ctx.io.stdout(
            written
              ? `Done: ${redeemed.request.summary}. Wrote ${name} to ${options.writeEnv} (the value is not shown).`
              : `Done: ${redeemed.request.summary}.`,
          );
        }
      },
    );
};
