import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { describe, expect, it } from "vitest";

import { run, tokenEnvVar, type Io } from "./cli.ts";
import { configPath } from "./config.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;
const me = {
  id: "u1",
  name: "Casey Customer",
  email: "casey@example.com",
  workspaces: [
    { id: "w1", name: "Acme", slug: "acme", role: "owner" },
    { id: "w2", name: "Beta", slug: "beta", role: "member" },
  ],
};

function fakeIo(overrides: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request);
    const url = request.url;
    if (url.endsWith("/v1/user/me")) return Response.json(me);
    if (url.endsWith("/v1/workspace")) {
      if (!request.headers.get("x-workspace")) {
        return Response.json(
          {
            error: {
              code: "invalid_request",
              message: "X-Workspace required",
              requestId: "r1",
            },
          },
          { status: 400 },
        );
      }
      return Response.json({ id: "w1", name: "Acme" });
    }
    return Response.json(
      { error: { code: "not_found", message: "Not found" } },
      { status: 404 },
    );
  };
  const io: Io = {
    env: {},
    homeDir: mkdtempSync(join(tmpdir(), "cli-home-")),
    fetch,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    stdin: async () => "",
    ...overrides,
  };
  return { io, out, err, calls };
}

describe(`${brand.name} cli`, () => {
  it("prints help naming the product and every command; unknown commands fail with help", async () => {
    const { io, out, err } = fakeIo();
    expect(await run([], io)).toBe(1);
    const help = err.join("\n");
    expect(help).toContain(`Usage: ${brand.name}`);
    expect(help).toContain(`${brand.productName} command line`);
    for (const c of ["login", "logout", "whoami", "workspace", "api", "config"])
      expect(help).toContain(c);
    expect(help).toContain(tokenEnvVar());
    expect(await run(["--help"], io)).toBe(0);
    expect(await run(["whoami", "--help"], io)).toBe(0);
    expect(out.at(-1)).toContain("Usage:");
    expect(out.at(-1)).toContain("--json");
    expect(await run(["nope"], io)).toBe(1);
    expect(err.join("\n")).toContain("unknown command 'nope'");
    expect(await run(["--version"], io)).toBe(0);
    expect(out.at(-1)).toBe("0.0.0-dev");
  });

  it("login stores the token 0600, verifies it, and picks the only workspace as default", async () => {
    const single = { ...me, workspaces: me.workspaces.slice(0, 1) };
    const { io, out } = fakeIo({
      fetch: async () => Response.json(single),
    });
    expect(
      await run(
        ["login", "--token", PAT, "--api", "http://localhost:8787"],
        io,
      ),
    ).toBe(0);
    const path = configPath(io.homeDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      token: PAT,
      api: "http://localhost:8787",
      workspace: "acme",
    });
    expect(out.join("\n")).toContain("Hello Casey Customer");
    // A token that is not ours is refused before anything is written.
    const other = fakeIo();
    expect(await run(["login", "--token", "sk_x_y"], other.io)).toBe(1);
    expect(other.err.join("\n")).toContain("not a");
  });

  it("keeps nothing when the token cannot be verified", async () => {
    const { io, err } = fakeIo({
      fetch: async () =>
        Response.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          { status: 401 },
        ),
    });
    expect(
      await run(["login", "--token", PAT, "--api", "http://typo:8787"], io),
    ).toBe(1);
    expect(err.join("\n")).toContain("nothing was saved");
    const saved = existsSync(configPath(io.homeDir))
      ? JSON.parse(readFileSync(configPath(io.homeDir), "utf8"))
      : {};
    expect(saved.token).toBeUndefined();
    expect(saved.api).toBeUndefined();
  });

  it("reads the token from stdin when --token is omitted", async () => {
    const { io } = fakeIo({ stdin: async () => `${PAT}\n` });
    expect(await run(["login"], io)).toBe(0);
    expect(JSON.parse(readFileSync(configPath(io.homeDir), "utf8")).token).toBe(
      PAT,
    );
  });

  it("whoami sends the bearer token without X-Workspace; the env token wins over the file", async () => {
    const { io, calls, out } = fakeIo();
    await run(["login", "--token", PAT], io);
    io.env = { [tokenEnvVar()]: `pat_${brand.identifier}_fromenv` };
    expect(await run(["whoami"], io)).toBe(0);
    const last = calls.at(-1)!;
    expect(last.headers.get("authorization")).toBe(
      `Bearer pat_${brand.identifier}_fromenv`,
    );
    expect(last.headers.has("x-workspace")).toBe(false);
    expect(last.url).toBe(`https://api.${brand.domain}/v1/user/me`);
    expect(out.join("\n")).toContain("acme");
    expect(out.join("\n")).toContain("beta");
    expect(await run(["whoami", "--json"], io)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual(me);
  });

  it("workspace use persists the default (members only); api sends X-Workspace and prints JSON", async () => {
    const { io, calls, out, err } = fakeIo();
    await run(["login", "--token", PAT], io);
    expect(await run(["workspace", "use", "nope"], io)).toBe(1);
    expect(err.at(-1)).toContain("not a member");
    expect(await run(["workspace", "use", "beta"], io)).toBe(0);
    expect(await run(["workspace"], io)).toBe(0);
    expect(out.at(-1)).toContain("beta *");
    expect(await run(["api", "get", "/v1/workspace"], io)).toBe(0);
    expect(calls.at(-1)!.headers.get("x-workspace")).toBe("beta");
    expect(calls.at(-1)!.method).toBe("GET");
    expect(JSON.parse(out.at(-1)!)).toEqual({ id: "w1", name: "Acme" });
    // --workspace overrides the default for one call; --data becomes the JSON body.
    await run(
      [
        "api",
        "post",
        "/v1/workspace",
        "--workspace",
        "acme",
        "--data",
        '{"a":1}',
      ],
      io,
    );
    const posted = calls.at(-1)!;
    expect(posted.headers.get("x-workspace")).toBe("acme");
    expect(posted.headers.get("content-type")).toBe("application/json");
    expect(await posted.text()).toBe('{"a":1}');
  });

  it("surfaces the API's error envelope, and refuses to call without a token or workspace", async () => {
    const { io, err } = fakeIo();
    expect(await run(["whoami"], io)).toBe(1);
    expect(err.at(-1)).toContain("not logged in");
    // Two workspaces → no default chosen by login → api needs one.
    const noWs = fakeIo();
    noWs.io.env = { [tokenEnvVar()]: PAT };
    expect(await run(["api", "get", "/v1/workspace"], noWs.io)).toBe(1);
    expect(noWs.err.at(-1)).toContain("no workspace selected");
    expect(
      await run(["api", "get", "/v1/missing", "--workspace", "acme"], noWs.io),
    ).toBe(1);
    expect(noWs.err.at(-1)).toContain("Not found (not_found)");
    // /v1/user/* needs no workspace even through the escape hatch.
    expect(await run(["api", "get", "/v1/user/me"], noWs.io)).toBe(0);
  });

  it("without environments sends none and names none (the API names none)", async () => {
    const { io, err, calls } = fakeIo();
    io.env = { [tokenEnvVar()]: PAT };
    const call = ["api", "get", "/v1/workspace", "--workspace", "acme"];
    expect(await run(call, io)).toBe(0);
    expect(calls.at(-1)!.headers.has("x-environment")).toBe(false);
    expect(err).toEqual([]);
    // A product whose environments are its own records still gets the
    // flag through; the API decides what it means.
    await run(["--environment", "staging", ...call], io);
    expect(calls.at(-1)!.headers.get("x-environment")).toBe("staging");
    expect(err).toEqual([]);
  });

  it("an API key acts in its own workspace: none to select, and --workspace is refused", async () => {
    const key = "sk_live_abcdefghijklmnopqrstuv";
    const { io, err, calls } = fakeIo({
      env: { [tokenEnvVar()]: key },
    });
    await run(["workspace", "members", "list"], io);
    expect(err.join("\n")).not.toContain("no workspace selected");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has("x-workspace")).toBe(false);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${key}`);

    const named = fakeIo({ env: { [tokenEnvVar()]: key } });
    expect(
      await run(
        ["workspace", "members", "list", "--workspace", "acme"],
        named.io,
      ),
    ).toBe(1);
    expect(named.calls).toHaveLength(0);
    expect(named.err.join("\n")).toContain(
      "an API key acts only in its own workspace",
    );
  });
});
