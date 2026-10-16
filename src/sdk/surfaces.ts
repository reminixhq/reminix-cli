/**
 * The /v1 SURFACE MANIFEST: for every operation in the OpenAPI document,
 * the CLI command and the MCP tool it becomes. ONE deterministic
 * derivation shared by the generators to come (apps/cli, apps/mcp —
 * docs/roadmap.md Phases 5–6), so a name is decided once, here, from the
 * route definition — never by a model, never twice. Pure: same document
 * in, same manifest out (sorted by operationId).
 *
 * Defaults come from the operationId (`[<namespace>.]<resource>.<action>`):
 *   workspace.auditEvents.list → CLI `workspace audit-events list`,
 *   MCP `workspace_audit_events_list`; a product's `limits.list` →
 *   `limits list`, `limits_list`
 * and a route overrides them with `x-cli` / `x-mcp` (defineV1Route in
 * apps/api/src/routes/v1/openapi.ts). Path parameters become positional
 * CLI arguments; DELETE asks for confirmation; MCP hints follow the
 * method. A snapshot test makes every surface change visible in review.
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export type OperationSurface = {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  cli: {
    command: string;
    args: string[];
    confirm: boolean;
    /**
     * The everyday command a product's hand-written CLI offers for this
     * operation (`x-cli.shortcut`), as typed after the program name with
     * its arguments: `run <slug>`. The skill and guides show it; the
     * reference shows it beside the long form.
     */
    shortcut?: string;
  };
  mcp:
    | {
        exposed: true;
        name: string;
        /** MCP tool annotations, from the HTTP method. */
        hints: {
          readOnlyHint: boolean;
          destructiveHint: boolean;
          idempotentHint: boolean;
        };
      }
    | { exposed: false; reason: string };
};

type Operation = {
  operationId?: string;
  summary?: string;
  "x-cli"?: {
    command?: string;
    args?: string[];
    confirm?: boolean;
    shortcut?: string;
  };
  "x-mcp"?: { name?: string } | { expose: false; reason: string };
};
type Document = {
  paths?: Record<string, Partial<Record<string, Operation>> | undefined>;
};

const METHODS: readonly HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
];

function words(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ");
}

export function operationSurfaces(document: Document): OperationSurface[] {
  const surfaces: OperationSurface[] = [];
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const op = operations?.[method];
      if (!op) continue;
      if (!op.operationId) {
        throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
      }
      // `workspace.members.list` → resource words "workspace members",
      // action "list"; two-part ids (`limits.list`) work the same way.
      const segments = op.operationId.split(".");
      const action = segments.pop()!;
      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const xMcp = op["x-mcp"];
      surfaces.push({
        operationId: op.operationId,
        method,
        path,
        summary: op.summary ?? "",
        cli: {
          command:
            op["x-cli"]?.command ??
            [...segments, action]
              .map((segment) => words(segment).join("-"))
              .join(" "),
          args: op["x-cli"]?.args ?? pathParams,
          confirm: op["x-cli"]?.confirm ?? method === "delete",
          ...(op["x-cli"]?.shortcut ? { shortcut: op["x-cli"].shortcut } : {}),
        },
        mcp:
          xMcp && "expose" in xMcp
            ? { exposed: false, reason: xMcp.reason }
            : {
                exposed: true,
                name:
                  xMcp?.name ?? [...segments, action].flatMap(words).join("_"),
                hints: {
                  readOnlyHint: method === "get",
                  destructiveHint: method === "delete",
                  idempotentHint:
                    method === "get" || method === "put" || method === "delete",
                },
              },
      });
    }
  }
  surfaces.sort((a, b) => a.operationId.localeCompare(b.operationId));
  assertUnique(
    surfaces.map((s) => s.cli.command),
    "CLI command",
  );
  assertUnique(
    surfaces.flatMap((s) => (s.mcp.exposed ? [s.mcp.name] : [])),
    "MCP tool name",
  );
  return surfaces;
}

function assertUnique(values: string[], what: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${what}: ${value}`);
    seen.add(value);
  }
}
