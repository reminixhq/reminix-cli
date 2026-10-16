import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { describe, expect, it, vi } from "vitest";

import { run, tokenEnvVar, type Io } from "./cli.ts";
import { configPath, environmentEnvVar } from "./config.ts";

/**
 * The command line in a product that DECLARES environments (test, the
 * default, and live — docs/architecture.md "Environments"). `@repo/brand`
 * is mocked for this file only; cli.test.ts covers the platform's own
 * path, where none are declared and nothing changes.
 */
vi.mock("./brand/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./brand/index.ts")>();
  return {
    ...actual,
    productEnvironments: actual.resolveProductEnvironments([
      { name: "test", keyPrefix: "acme_test_", readOnlyWorkspace: true },
      { name: "live", keyPrefix: "acme_live_" },
    ]),
  };
});

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;

/** A terminal whose API acts where it is asked, else in test — and says so. */
function terminal(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Request[] = [];
  const io: Io = {
    env: { [tokenEnvVar()]: PAT, ...env },
    homeDir: mkdtempSync(join(tmpdir(), "cli-env-")),
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      calls.push(request);
      const environment = request.headers.get("x-environment") ?? "test";
      if (environment === "staging") {
        return Response.json(
          {
            error: {
              code: "invalid_request",
              message: 'Unknown environment "staging"',
            },
          },
          { status: 400 },
        );
      }
      return Response.json(
        { id: "w1", name: "Acme" },
        { headers: { "x-environment": environment } },
      );
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: async () => "",
  };
  return { io, out, err, calls };
}

const getWorkspace = ["workspace", "get", "--workspace", "acme"];

describe("environments (declared)", () => {
  it("send none by default, and name the one the API acted in on stderr", async () => {
    const { io, out, err, calls } = terminal();
    expect(await run(getWorkspace, io)).toBe(0);
    expect(calls[0].headers.has("x-environment")).toBe(false);
    expect(out).toContain("name: Acme");
    expect(err).toEqual(["Environment: test"]);
  });

  it("take --environment over the shell variable over the config", async () => {
    const { io, calls } = terminal({ [environmentEnvVar()]: "test" });
    expect(await run(["environment", "use", "live"], io)).toBe(0);
    expect(
      JSON.parse(readFileSync(configPath(io.homeDir), "utf8")),
    ).toMatchObject({ environment: "live" });

    // The shell variable beats the config …
    await run(getWorkspace, io);
    expect(calls.at(-1)!.headers.get("x-environment")).toBe("test");
    // … the flag beats both, before or after the command …
    await run(["--environment", "live", ...getWorkspace], io);
    expect(calls.at(-1)!.headers.get("x-environment")).toBe("live");
    await run([...getWorkspace, "--environment", "live"], io);
    expect(calls.at(-1)!.headers.get("x-environment")).toBe("live");
    // … and without the variable the config applies, to the escape hatch too.
    io.env = { [tokenEnvVar()]: PAT };
    await run(["api", "get", "/v1/workspace", "--workspace", "acme"], io);
    expect(calls.at(-1)!.headers.get("x-environment")).toBe("live");
  });

  it("keep --json output exactly the API's JSON, the environment on stderr", async () => {
    const { io, out, err } = terminal();
    await run(["--environment", "live", ...getWorkspace, "--json"], io);
    expect(JSON.parse(out.join("\n"))).toEqual({ id: "w1", name: "Acme" });
    expect(err).toEqual(["Environment: live"]);
  });

  it("report a refused environment, and only accept declared names in `environment use`", async () => {
    const { io, err } = terminal();
    expect(await run(["--environment", "staging", ...getWorkspace], io)).toBe(
      1,
    );
    expect(err.at(-1)).toContain('Unknown environment "staging"');
    expect(await run(["environment", "use", "staging"], io)).toBe(1);
    expect(err.at(-1)).toContain("test, live");
  });

  it("list the environments with the current one marked, and forget the default", async () => {
    const { io, out } = terminal();
    await run(["environment"], io);
    expect(out).toEqual(["test *", "live", "(the default)"]);
    await run(["environment", "use", "live"], io);
    out.length = 0;
    await run(["environment"], io);
    expect(out).toEqual(["test", "live *", "(from config)"]);
    await run(["environment", "unset"], io);
    out.length = 0;
    await run(["environment"], io);
    expect(out[0]).toBe("test *");
  });
});
