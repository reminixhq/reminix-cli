import { brand } from "./brand/index.ts";
import { unwrap, type Schemas } from "@reminix/sdk";

import type { Command } from "./cli.ts";
import { json } from "./output.ts";

type Usage = Schemas["WorkspaceUsage"];

/**
 * `workspace usage` — hand-written over the generated command of the
 * same name so each count reads as a sentence, with where it stands
 * (docs/architecture.md "Workspace usage"): the same words as the app's
 * Billing card. `--json` prints the API's response as it is.
 */
export const usage: Command = (program, ctx) => {
  const workspace =
    program.commands.find((c) => c.name() === "workspace") ??
    program.command("workspace");
  workspace
    .command("usage")
    .description("Show your plan's usage this period")
    .option("--workspace <slug>", "act in this workspace for one call")
    .option("--json", "machine-readable output")
    .action(async (options: { workspace?: string; json?: boolean }) => {
      const result = unwrap(
        await ctx
          .client({ workspace: options.workspace })
          .GET("/workspace/usage"),
      );
      if (options.json) {
        ctx.io.stdout(json(result));
        return;
      }
      for (const line of usageLines(result)) ctx.io.stdout(line);
    });
};

const number = (n: number) => n.toLocaleString("en-US");

/** The readable output: when it resets, then a line per count, then the notices. */
export function usageLines(usage: Usage): string[] {
  const resets = new Date(usage.periodEnd).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const lines = [`Usage this period. Counters reset on ${resets}.`];
  if (usage.counts.length === 0) lines.push("Your plan counts nothing.");
  for (const count of usage.counts) {
    const figures =
      count.limit === null
        ? `${number(count.used)} (no limit)`
        : `${number(count.used)} of ${number(count.limit)}`;
    const state =
      count.state === "grace"
        ? count.stopsAt === null
          ? " Over your plan."
          : ` Over your plan. Past ${number(count.stopsAt)}, ${brand.productName} refuses new use.`
        : count.state === "stopped"
          ? ` ${brand.productName} refuses new use until ${resets}.`
          : count.state === "over"
            ? " Over your plan."
            : count.limit === 0
              ? " Not in your plan."
              : "";
    lines.push(`${count.label}: ${figures}.${state}`);
  }
  for (const notice of usage.notices ?? []) lines.push(notice);
  return lines;
}
