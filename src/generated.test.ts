import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { describe, expect, it } from "vitest";

import { run, type Io } from "./cli.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;

/** A terminal with a stored-token override and a scripted API. */
function terminal(respond: (request: Request) => Response) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { request: Request; body: string }[] = [];
  const io: Io = {
    env: { [`${brand.identifier.toUpperCase()}_TOKEN`]: PAT },
    homeDir: mkdtempSync(join(tmpdir(), "cli-gen-")),
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      calls.push({ request, body: await request.clone().text() });
      return respond(request);
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: async () => "",
  };
  return { io, out, err, calls };
}

describe("generated commands (one per /v1 operation)", () => {
  it("sends the operation's request: method, path, body, workspace, idempotency key", async () => {
    const { io, out, calls } = terminal(() =>
      Response.json(
        {
          endpoint: { id: "we_1", url: "https://example.com/h" },
          secret: "whsec_x",
        },
        { status: 201 },
      ),
    );
    const code = await run(
      [
        "workspace",
        "webhook-endpoints",
        "create",
        "--url",
        "https://example.com/h",
        "--workspace",
        "acme",
      ],
      io,
    );
    expect(code).toBe(0);
    const [{ request, body }] = calls;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      "/v1/workspace/webhook-endpoints",
    );
    expect(JSON.parse(body)).toEqual({ url: "https://example.com/h" });
    expect(request.headers.get("x-workspace")).toBe("acme");
    expect(request.headers.get("authorization")).toBe(`Bearer ${PAT}`);
    expect(request.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(out).toContain("secret: whsec_x");
  });

  it("retries a failed write with the same key, and derives keys from --idempotency-key", async () => {
    const create = [
      "workspace",
      "webhook-endpoints",
      "create",
      "--url",
      "https://example.com/h",
      "--workspace",
      "acme",
      "--idempotency-key",
      "setup-7",
    ];
    let attempts = 0;
    const first = terminal(() =>
      ++attempts === 1
        ? Response.json({}, { status: 503 })
        : Response.json({ endpoint: {}, secret: "whsec_x" }, { status: 201 }),
    );
    expect(await run(create, first.io)).toBe(0);
    const keys = first.calls.map((c) =>
      c.request.headers.get("idempotency-key"),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^setup-7:[0-9a-f]{16}$/);
    expect(keys[1]).toBe(keys[0]);

    // Run again with the same key: the same write sends the same key.
    const again = terminal(() =>
      Response.json({ endpoint: {}, secret: "whsec_x" }, { status: 201 }),
    );
    await run(create, again.io);
    expect(again.calls[0]!.request.headers.get("idempotency-key")).toBe(
      keys[0],
    );
  });

  it("puts path parameters in the path and query flags in the query; reads send no idempotency key", async () => {
    const { io, out, calls } = terminal(() =>
      Response.json({
        items: [{ id: "del_1", eventType: "ping", status: "delivered" }],
        nextCursor: "abc",
      }),
    );
    await run(
      [
        "workspace",
        "webhook-deliveries",
        "list",
        "we_1",
        "--limit",
        "5",
        "--workspace",
        "acme",
      ],
      io,
    );
    const url = new URL(calls[0].request.url);
    expect(url.pathname).toBe(
      "/v1/workspace/webhook-endpoints/we_1/deliveries",
    );
    expect(url.searchParams.get("limit")).toBe("5");
    expect(calls[0].request.headers.get("idempotency-key")).toBeNull();
    expect(out[0]).toContain("del_1");
    expect(out.at(-1)).toBe("More: --cursor abc");
  });

  it("prints the API's JSON with --json", async () => {
    const page = { items: [{ id: "we_1" }], nextCursor: null };
    const { io, out } = terminal(() => Response.json(page));
    await run(
      [
        "workspace",
        "webhook-endpoints",
        "list",
        "--workspace",
        "acme",
        "--json",
      ],
      io,
    );
    expect(JSON.parse(out.join("\n"))).toEqual(page);
  });

  it("asks for --yes before an operation that cannot be undone", async () => {
    const { io, err, calls } = terminal(
      () => new Response(null, { status: 204 }),
    );
    expect(
      await run(
        [
          "workspace",
          "webhook-endpoints",
          "delete",
          "we_1",
          "--workspace",
          "acme",
        ],
        io,
      ),
    ).toBe(1);
    expect(err.join("\n")).toMatch(/--yes/);
    expect(calls).toHaveLength(0);
    const confirmed = terminal(() => new Response(null, { status: 204 }));
    await run(
      [
        "workspace",
        "webhook-endpoints",
        "delete",
        "we_1",
        "--workspace",
        "acme",
        "--yes",
      ],
      confirmed.io,
    );
    expect(confirmed.calls[0].request.method).toBe("DELETE");
    expect(confirmed.out).toEqual(["Done."]);
  });

  it("names a missing required flag, and reports API errors as JSON with --json", async () => {
    const missing = terminal(() => Response.json({}));
    expect(
      await run(
        ["workspace", "webhook-endpoints", "create", "--workspace", "acme"],
        missing.io,
      ),
    ).toBe(1);
    expect(missing.err.join("\n")).toContain("missing --url");

    const failing = terminal(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message:
              "This credential is not granted the workspace.webhooks:read scope",
            requestId: "r1",
          },
        },
        { status: 403 },
      ),
    );
    expect(
      await run(
        [
          "workspace",
          "webhook-endpoints",
          "list",
          "--workspace",
          "acme",
          "--json",
        ],
        failing.io,
      ),
    ).toBe(1);
    expect(JSON.parse(failing.err[0])).toEqual({
      error: {
        code: "forbidden",
        message:
          "This credential is not granted the workspace.webhooks:read scope",
        status: 403,
        requestId: "r1",
      },
    });
  });

  it("leaves hand-written commands in place (they win on a name clash)", async () => {
    const { io, out } = terminal(() => Response.json({}));
    await run(["workspace", "--help"], io);
    const help = out.join("\n");
    expect(help).toContain("use <slug>");
    expect(help).toContain("get [options]");
  });
});

describe("generated command groups", () => {
  it("describe themselves by the actions they hold", async () => {
    const { io, out, err } = terminal(() => Response.json({}));
    await run(["workspace", "--help"], io);
    const help = [...out, ...err].join("\n");
    expect(help).toMatch(/webhook-endpoints\s+.*create, .*list/);
    expect(help).not.toMatch(/webhook-endpoints commands/);
  });
});
