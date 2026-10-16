import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { describe, expect, it } from "vitest";

import { browserLogin, webOriginFor } from "./browser-login.ts";
import { run, type Io } from "./cli.ts";
import { configPath } from "./config.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;

/** What /cli/authorize does after Allow: a form POST to the listener. */
function handOff(pageUrl: string, fields: Record<string, string>) {
  const url = new URL(pageUrl);
  const port = url.searchParams.get("port");
  return fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("browser login (loopback listener)", () => {
  it("accepts the token only with this login's state", async () => {
    let page = "";
    const login = browserLogin({
      webOrigin: "https://app.example.com",
      computer: "laptop",
      onUrl: () => {},
      openUrl: (url) => {
        page = url;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const url = new URL(page);
    expect(url.origin + url.pathname).toBe(
      "https://app.example.com/cli/authorize",
    );
    expect(url.searchParams.get("name")).toBe("laptop");
    // A hand-off with another state is refused and the login keeps waiting.
    const forged = await handOff(page, { state: "someone-else", token: "x" });
    expect(forged.status).toBe(400);
    const real = await handOff(page, {
      state: url.searchParams.get("state")!,
      token: PAT,
    });
    expect(real.status).toBe(200);
    await expect(login).resolves.toBe(PAT);
  });

  it("rejects when the person denies it", async () => {
    let page = "";
    const login = browserLogin({
      webOrigin: "https://app.example.com",
      computer: "laptop",
      onUrl: () => {},
      openUrl: (url) => {
        page = url;
      },
    });
    // Observe the outcome before the hand-off settles it.
    const outcome = login.then(
      () => null,
      (error: Error) => error,
    );
    await new Promise((r) => setTimeout(r, 50));
    await handOff(page, {
      state: new URL(page).searchParams.get("state")!,
      error: "access_denied",
    });
    expect((await outcome)?.message).toMatch(/denied/);
  });

  it("derives the web app's origin from the API's", () => {
    expect(webOriginFor("https://api.limitry.com")).toBe(
      "https://app.limitry.com",
    );
    expect(webOriginFor("http://localhost:8787")).toBe("http://localhost:3000");
    expect(webOriginFor("https://example.com")).toBeNull();
  });
});

describe("login and logout", () => {
  function io(overrides: Partial<Io> = {}) {
    const out: string[] = [];
    const calls: Request[] = [];
    const value: Io = {
      env: {},
      homeDir: mkdtempSync(join(tmpdir(), "cli-login-")),
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        calls.push(request);
        if (request.url.endsWith("/v1/user/me")) {
          return Response.json({
            id: "u1",
            name: "Casey",
            email: "casey@example.com",
            workspaces: [
              { id: "w1", name: "Acme", slug: "acme", role: "owner" },
            ],
          });
        }
        if (request.url.endsWith("/v1/user/token")) {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
      stdout: (line) => out.push(line),
      stderr: () => {},
      stdin: async () => "",
      ...overrides,
    };
    return { io: value, out, calls };
  }

  it("signs a person in through the browser and keeps the token", async () => {
    const { io: terminal, out } = io({
      interactive: true,
      hostname: "laptop",
      openUrl: (url) => {
        const state = new URL(url).searchParams.get("state")!;
        void handOff(url, { state, token: PAT });
      },
    });
    expect(
      await run(["login", "--api", "http://localhost:8787"], terminal),
    ).toBe(0);
    const saved = JSON.parse(
      readFileSync(configPath(terminal.homeDir), "utf8"),
    ) as { token: string; workspace: string };
    expect(saved).toMatchObject({ token: PAT, workspace: "acme" });
    expect(out.join("\n")).toContain("Logged in.");
  });

  it("logout revokes the token on the server, then forgets it", async () => {
    const { io: terminal, calls } = io();
    expect(await run(["login", "--token", PAT], terminal)).toBe(0);
    expect(await run(["logout"], terminal)).toBe(0);
    const revoke = calls.find((c) => c.url.endsWith("/v1/user/token"));
    expect(revoke?.method).toBe("DELETE");
    expect(revoke?.headers.get("authorization")).toBe(`Bearer ${PAT}`);
    const saved = JSON.parse(
      readFileSync(configPath(terminal.homeDir), "utf8"),
    ) as { token?: string };
    expect(saved.token).toBeUndefined();
  });
});
