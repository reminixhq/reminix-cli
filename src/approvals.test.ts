import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { describe, expect, it } from "vitest";

import { writeEnvVar } from "./approvals.ts";
import { run, type Io } from "./cli.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;
const SECRET = "sk_live_TOPSECRET";

function terminal(status: string) {
  const out: string[] = [];
  const err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "cli-apr-"));
  const request = {
    id: "apr_1",
    status,
    summary: "Create the API key “acme-web” with workspace:read",
    approveUrl: "https://app.example.test/approvals/apr_1",
    secret: { name: "API key", envVar: "ACME_API_KEY" },
  };
  const io: Io = {
    env: { [`${brand.identifier.toUpperCase()}_TOKEN`]: PAT },
    homeDir: dir,
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path.endsWith("/redeem")) {
        return Response.json({
          request: { ...request, status: "completed" },
          secret: SECRET,
          envVar: "ACME_API_KEY",
        });
      }
      return Response.json(request);
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: async () => "",
  };
  return { io, out, err, envFile: join(dir, ".env") };
}

describe("workspace approval-requests redeem", () => {
  it("writes the secret to the env file and never prints it", async () => {
    const t = terminal("approved");
    const code = await run(
      [
        "workspace",
        "approval-requests",
        "redeem",
        "apr_1",
        "--write-env",
        t.envFile,
        "--workspace",
        "acme",
      ],
      t.io,
    );
    expect(code).toBe(0);
    expect(readFileSync(t.envFile, "utf8")).toBe(`ACME_API_KEY=${SECRET}\n`);
    expect(statSync(t.envFile).mode & 0o777).toBe(0o600);
    expect([...t.out, ...t.err].join("\n")).not.toContain(SECRET);
    expect(t.out[0]).toMatch(
      /Wrote ACME_API_KEY to .*\.env \(the value is not shown\)/,
    );
  });

  it("keeps the secret out of --json output too", async () => {
    const t = terminal("approved");
    await run(
      [
        "workspace",
        "approval-requests",
        "redeem",
        "apr_1",
        "--write-env",
        t.envFile,
        "--json",
        "--workspace",
        "acme",
      ],
      t.io,
    );
    expect(t.out.join("\n")).not.toContain(SECRET);
    expect(JSON.parse(t.out.join("\n")).written).toEqual({
      file: t.envFile,
      envVar: "ACME_API_KEY",
    });
  });

  it("refuses without --write-env, and points to the approval while pending", async () => {
    const t = terminal("pending");
    expect(
      await run(
        [
          "workspace",
          "approval-requests",
          "redeem",
          "apr_1",
          "--workspace",
          "acme",
        ],
        t.io,
      ),
    ).toBe(1);
    expect(
      await run(
        [
          "workspace",
          "approval-requests",
          "redeem",
          "apr_1",
          "--write-env",
          t.envFile,
          "--workspace",
          "acme",
        ],
        t.io,
      ),
    ).toBe(1);
    expect(t.err.join("\n")).toContain(
      "https://app.example.test/approvals/apr_1",
    );
  });
});

describe("writeEnvVar", () => {
  it("replaces an existing variable and keeps the rest", () => {
    const file = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
    writeFileSync(file, "A=1\nACME_API_KEY=old\nB=2\n");
    writeEnvVar(file, "ACME_API_KEY", "new");
    expect(readFileSync(file, "utf8")).toBe("A=1\nACME_API_KEY=new\nB=2\n");
    writeEnvVar(file, "C", "3");
    expect(readFileSync(file, "utf8")).toBe(
      "A=1\nACME_API_KEY=new\nB=2\nC=3\n",
    );
  });
});
