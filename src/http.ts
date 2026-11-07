import { unwrap } from "@reminix/sdk";

import type { CliContext } from "./cli.ts";

/**
 * The `api` escape hatch: one call to ANY path, typed by nobody — for
 * endpoints the CLI has no command for (a product's own routes, new
 * platform routes before the CLI learns them). It goes through the same
 * openapi-fetch client as the typed commands (credentials, X-Workspace,
 * error envelope), just without the generated path types: this is the
 * one place the CLI deliberately steps outside them.
 */
type UntypedClient = {
  request(
    method: string,
    path: string,
    init: { baseUrl: string; body?: unknown },
  ): Promise<{ data?: unknown; error?: unknown; response: Response }>;
};

export async function rawRequest(
  ctx: CliContext,
  options: {
    method: string;
    path: string;
    body?: unknown;
    workspace?: string;
  },
): Promise<unknown> {
  // /v1/user/* never takes a workspace; everything else needs one.
  const needsWorkspace = !options.path.startsWith("/v1/user");
  const workspace = needsWorkspace ? options.workspace : false;
  const client = ctx.client({ workspace }) as unknown as UntypedClient;
  return unwrap(
    await client.request(options.method, options.path, {
      // The client's base URL ends in /v1; the path given here is absolute.
      baseUrl: ctx.credentials({ workspace }).api,
      body: options.body,
    }),
  );
}
