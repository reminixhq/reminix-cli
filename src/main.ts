#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir, hostname } from "node:os";

import { run } from "./cli.ts";

// The real world: process stdio, env, home, and global fetch. Everything
// testable lives behind `run()`.
const code = await run(process.argv.slice(2), {
  env: process.env,
  homeDir: homedir(),
  fetch: globalThis.fetch,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  interactive: Boolean(process.stdin.isTTY),
  hostname: hostname(),
  // Best effort: the URL is printed too, for when no browser opens.
  openUrl: (url) => {
    const [command, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  },
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
});
process.exit(code);
