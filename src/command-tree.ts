import type { Command as Commander } from "commander";

import { createProgram } from "./cli.ts";
import { OPERATION, type Marked } from "./covers.ts";

/**
 * The CLI's commands as people see them (`--help`), for the docs' list
 * on the CLI page (apps/docs/scripts/reference.mjs): hidden commands
 * left out (./covers.ts), generated ones knowing their operation.
 */
export type CommandEntry = {
  /** The whole command as typed, arguments included: `reminix scripts run <slug>`. */
  usage: string;
  /** Its first group (`scripts`), or "" for a top-level command (`login`). */
  group: string;
  description: string;
  /** The API operation a generated command calls, if it is one. */
  operationId?: string;
};

/** The commands `--help` shows, depth first, in their groups. */
export function commandTree(): CommandEntry[] {
  const program = createProgram({
    env: {},
    homeDir: "/nonexistent",
    fetch: () => Promise.reject(new Error("no network")),
    stdout: () => {},
    stderr: () => {},
    stdin: async () => "",
  });
  const help = program.createHelp();
  const entries: CommandEntry[] = [];
  const walk = (command: Commander, path: string[]) => {
    for (const sub of help.visibleCommands(command)) {
      if (sub.name() === "help") continue;
      const words = [...path, sub.name()];
      const visible = help
        .visibleCommands(sub)
        .filter((c) => c.name() !== "help");
      if (visible.length > 0) {
        walk(sub, words);
        continue;
      }
      const args = sub.registeredArguments.map((arg) => {
        const name = arg.variadic ? `${arg.name()}...` : arg.name();
        return arg.required ? `<${name}>` : `[${name}]`;
      });
      entries.push({
        usage: [program.name(), ...words, ...args].join(" "),
        group: words.length > 1 ? words[0] : "",
        description: sub.description().split("\n")[0],
        ...((sub as Marked)[OPERATION]
          ? { operationId: (sub as Marked)[OPERATION] }
          : {}),
      });
    }
  };
  walk(program, []);
  return entries;
}
