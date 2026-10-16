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
    expect(t.calls).toEqual([
      {
        method: "PUT",
        path: "/v1/secrets/STRIPE_KEY",
        body: {
          value: "sk_live_123",
          hosts: ["api.stripe.com", "hooks.stripe.com"],
          allowEnv: false,
        },
      },
    ]);
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
      path: "/v1/secrets/STRIPE_KEY",
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
    expect(t.calls[0]).not.toHaveProperty("environment");
    expect(t.err).toContain("Environment: production");
  });
});
