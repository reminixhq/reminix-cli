/**
 * PRODUCT-OWNED command-line commands. The platform NEVER edits this
 * directory — ../cli.ts registers `productCommands` after the platform's
 * (login, logout, whoami, workspace, api, config), so a fork's commands
 * live here and `pnpm platform:apply` cherry-picks never collide with them
 * (docs/conventions.md, "Fork-owned seams").
 *
 * A command is a function `(program, ctx) => void` that registers itself
 * with commander; `ctx.client()` is the typed API client from @repo/sdk
 * (generated from the /v1 routes, so a product's own endpoints are typed
 * once `pnpm sdk:generate` has run) and `ctx.io` prints:
 *
 *   import { unwrap } from "@reminix/sdk";
 *   import type { Command } from "../cli.ts";
 *   import { json } from "../output.ts";
 *   const widgets: Command = (program, ctx) => {
 *     program
 *       .command("widgets")
 *       .description("List the workspace's widgets")
 *       .option("--workspace <slug>", "act in this workspace")
 *       .action(async (options: { workspace?: string }) => {
 *         const client = ctx.client({ workspace: options.workspace });
 *         ctx.io.stdout(json(unwrap(await client.GET("/widgets"))));
 *       });
 *   };
 *   export const productCommands: Command[] = [widgets];
 *
 * Remember the matching scope for the route (apps/api/src/lib/
 * scopes/product/) so scoped tokens can be granted it.
 */
import type { Command } from "../cli.ts";
import { fileCommands } from "./files.ts";
import { scriptCommands } from "./scripts.ts";
import { initCommand } from "./init.ts";
import { secretCommands } from "./secrets.ts";

export const productCommands: Command[] = [
  initCommand,
  scriptCommands,
  fileCommands,
  secretCommands,
];
