import type { Command as Commander } from "commander";

/**
 * Two marks on a commander command, read by the docs' command list
 * (./command-tree.ts):
 *
 * - `covers(command, …operationIds)`: a hand-written command that does
 *   the job of some API operations (`scripts run` starts a run, follows
 *   it and downloads what it wrote) hides their generated commands
 *   (`runs create`) from help and from the docs. They still run when
 *   typed, so nothing that uses them breaks.
 * - the generated command for an operation carries its operation id, so
 *   the docs link it to its section under Endpoints.
 */
const COVERS = Symbol.for("cli.covers");
export const OPERATION = Symbol.for("cli.operation");

export type Marked = Commander & { [COVERS]?: string[]; [OPERATION]?: string };

/** Marks a hand-written command as doing the job of these operations. */
export function covers<C extends Commander>(
  command: C,
  ...operationIds: string[]
): C {
  const marked = command as Marked;
  marked[COVERS] = [...(marked[COVERS] ?? []), ...operationIds];
  return command;
}

/** Marks a generated command with the operation it calls. */
export function markOperation(command: Commander, operationId: string) {
  (command as Marked)[OPERATION] = operationId;
}

/** Every operation some registered command covers. */
export function coveredOperations(program: Commander): Set<string> {
  const covered = new Set<string>();
  const walk = (command: Commander) => {
    for (const id of (command as Marked)[COVERS] ?? []) covered.add(id);
    for (const sub of command.commands) walk(sub);
  };
  walk(program);
  return covered;
}
