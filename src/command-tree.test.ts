import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { describe, expect, it, vi } from "vitest";

/**
 * A hand-written command that does the job of an operation hides that
 * operation's generated command from help and from the docs' list, and
 * the hidden command still runs when typed (./covers.ts).
 */
vi.mock("./product/index.ts", async () => {
  const { covers } = await import("./covers.ts");
  return {
    productCommands: [
      (program: import("commander").Command) => {
        covers(
          program
            .command("send-test-hook")
            .description("Send a test event to every endpoint")
            .action(() => {}),
          "workspace.webhookEndpoints.test",
        );
        program
          .command("publish-all [dirs...]")
          .description("Takes several folders")
          .action(() => {});
      },
    ],
  };
});

const { createProgram, run } = await import("./cli.ts");
const { commandTree } = await import("./command-tree.ts");

function io(out: string[] = []) {
  return {
    env: {
      [`${brand.identifier.toUpperCase()}_TOKEN`]: `pat_${brand.identifier}_abcdefghijklmnop`,
    },
    homeDir: mkdtempSync(join(tmpdir(), "cli-tree-")),
    fetch: async () => Response.json({}),
    stdout: (line: string) => out.push(line),
    stderr: () => {},
    stdin: async () => "",
  };
}

describe("the command tree", () => {
  it("leaves a covered command out of help and the docs, and links the rest", () => {
    const usages = commandTree().map((entry) => entry.usage);
    expect(usages).toContain(`${brand.name} send-test-hook`);
    // A variadic argument shows as such, not as one value.
    expect(usages).toContain(`${brand.name} publish-all [dirs...]`);
    expect(usages).not.toContain(
      `${brand.name} workspace webhook-endpoints test <endpoint-id>`,
    );
    const list = commandTree().find(
      (entry) =>
        entry.usage === `${brand.name} workspace webhook-endpoints list`,
    );
    expect(list).toMatchObject({
      group: "workspace",
      operationId: "workspace.webhookEndpoints.list",
    });
    const help = createProgram(io())
      .commands.find((c) => c.name() === "workspace")!
      .commands.find((c) => c.name() === "webhook-endpoints")!;
    expect(help.description()).not.toContain("test");
  });

  it("still runs the covered command when typed", async () => {
    const out: string[] = [];
    const code = await run(
      ["workspace", "webhook-endpoints", "test", "we_1", "--workspace", "acme"],
      io(out),
    );
    expect(code).toBe(0);
  });
});
