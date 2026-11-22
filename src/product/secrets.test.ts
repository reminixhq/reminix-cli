import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "../brand/index.ts";
import { describe, expect, it } from "vitest";

import { run, type Io } from "../cli.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;

function terminal(stdin: string) {
  const calls: {
    method: string;
    path: string;
    body?: unknown;
    environment?: string;
  }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { [`${brand.identifier.toUpperCase()}_TOKEN`]: PAT },
    homeDir: mkdtempSync(join(tmpdir(), "sec-home-")),
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const text = await req.text();
      const environment = req.headers.get("x-environment");
      calls.push({
        method: req.method,
        path: new URL(req.url).pathname,
        body: text ? JSON.parse(text) : undefined,
        ...(environment ? { environment } : {}),
      });
      if (new URL(req.url).pathname === "/v1/environments") {
        return Response.json({
          items: [
            { name: "production", isDefault: true },
            { name: "staging", isDefault: false },
          ],
          nextCursor: null,
        });
      }
      return Response.json(
        { name: "STRIPE_KEY", hosts: ["api.stripe.com"] },
        { headers: { "x-environment": environment ?? "production" } },
      );
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: async () => stdin,
  };
  return { io, calls, out, err };
}

describe("secrets set", () => {
  it("reads the value from stdin and never prints it", async () => {
    const t = terminal("sk_live_123\n");
    const code = await run(
      [
        "secrets",
        "set",
        "STRIPE_KEY",
        "--hosts",
        "api.stripe.com, hooks.stripe.com",
        "--workspace",
        "acme",
      ],
      t.io,
    );
    expect(code).toBe(0);
    // No environment chosen: the workspace's default, by name.
    expect(t.calls).toEqual([
      { method: "GET", path: "/v1/environments", body: undefined },
      {
        method: "PUT",
        path: "/v1/secrets/STRIPE_KEY/values/production",
        body: {
          value: "sk_live_123",
          hosts: ["api.stripe.com", "hooks.stripe.com"],
        },
      },
    ]);
    expect(t.out).toContain("Saved STRIPE_KEY in production.");
    expect([...t.out, ...t.err].join("\n")).not.toContain("sk_live_123");
  });

  it("refuses an empty value and has no --value option", async () => {
    const empty = terminal("");
    expect(
      await run(
        [
          "secrets",
          "set",
          "X",
          "--hosts",
          "a.example.com",
          "--workspace",
          "acme",
        ],
        empty.io,
      ),
    ).not.toBe(0);
    expect(empty.calls).toEqual([]);
    const flag = terminal("v");
    expect(
      await run(
        [
          "secrets",
          "set",
          "X",
          "--hosts",
          "a.example.com",
          "--value",
          "leak",
          "--workspace",
          "acme",
        ],
        flag.io,
      ),
    ).not.toBe(0);
    expect(flag.calls).toEqual([]);
  });

  it("sets allowEnvVar on the secret only when asked, either way", async () => {
    for (const [option, allowEnvVar] of [
      ["--allow-env-var", true],
      ["--no-allow-env-var", false],
    ] as const) {
      const t = terminal("v");
      const args = ["secrets", "set", "X", "--hosts", "a.example.com"];
      expect(
        await run(
          [...args, option, "--workspace", "acme", "--environment", "staging"],
          t.io,
        ),
      ).toBe(0);
      expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "PUT /v1/secrets/X/values/staging",
        "PATCH /v1/secrets/X",
      ]);
      expect(t.calls[1]?.body).toEqual({ allowEnvVar });
    }
  });
});

describe("secrets in an environment", () => {
  it("sets the value in the environment --environment names, and says which", async () => {
    const t = terminal("sk_test_123");
    const code = await run(
      [
        "secrets",
        "set",
        "STRIPE_KEY",
        "--hosts",
        "api.stripe.com",
        "--workspace",
        "acme",
        "--environment",
        "staging",
      ],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.calls[0]).toMatchObject({
      method: "PUT",
      path: "/v1/secrets/STRIPE_KEY/values/staging",
      environment: "staging",
    });
    expect(t.err).toContain("Environment: staging");
  });

  it("names the default the API acted in when none is given", async () => {
    const t = terminal("sk_live_123");
    await run(
      [
        "secrets",
        "set",
        "STRIPE_KEY",
        "--hosts",
        "api.stripe.com",
        "--workspace",
        "acme",
      ],
      t.io,
    );
    expect(t.calls[1]).toMatchObject({
      path: "/v1/secrets/STRIPE_KEY/values/production",
    });
    expect(t.calls[1]).not.toHaveProperty("environment");
    expect(t.err).toContain("Environment: production");
  });
});
