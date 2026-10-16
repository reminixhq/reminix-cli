import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import type { Operation } from "./sdk/operations.gen.ts";
import { describe, expect, it, vi } from "vitest";

import { run, type Io } from "./cli.ts";

/**
 * Generated commands for operations on raw bytes (a file upload, a file
 * download) — none of the platform's own, so the table is a stand-in,
 * under a name no product's own command takes (a product's command of
 * the same name would replace the generated one, as designed).
 */
vi.mock("./sdk/operations.gen.ts", async (original) => {
  const actual = await original<typeof import("./sdk/operations.gen.ts")>();
  const base = {
    tool: { name: "x", expose: true },
    workspace: true,
    description: "",
  };
  const ops = [
    {
      ...base,
      operationId: "files.upload",
      method: "post",
      path: "/files",
      summary: "Upload a file",
      cli: { command: "raw-example upload", args: [], confirm: false },
      fields: [
        {
          name: "name",
          in: "query",
          type: "string",
          required: true,
          schema: { type: "string" },
        },
      ],
      hasBody: false,
      rawBody: "application/octet-stream",
    },
    {
      ...base,
      operationId: "files.download",
      method: "get",
      path: "/files/{fileId}/content",
      summary: "Download a file",
      cli: {
        command: "raw-example download",
        args: ["fileId"],
        confirm: false,
      },
      fields: [
        {
          name: "fileId",
          in: "path",
          type: "string",
          required: true,
          schema: { type: "string" },
        },
      ],
      hasBody: false,
      rawResponse: "application/octet-stream",
    },
  ] as unknown as Operation[];
  return { ...actual, OPERATIONS: ops };
});

function terminal(respond: (request: Request) => Response) {
  const out: string[] = [];
  const calls: { request: Request; body: string }[] = [];
  const io: Io = {
    env: {
      [`${brand.identifier.toUpperCase()}_TOKEN`]: `pat_${brand.identifier}_abcdefghijklmnop`,
    },
    homeDir: mkdtempSync(join(tmpdir(), "cli-raw-")),
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      calls.push({ request, body: await request.clone().text() });
      return respond(request);
    },
    stdout: (line) => out.push(line),
    stderr: () => {},
    stdin: async () => "",
  };
  return { io, out, calls };
}

describe("generated commands on raw bytes", () => {
  it("sends --file as the body, and saves an answer to --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-raw-files-"));
    const source = join(dir, "in.csv");
    writeFileSync(source, "id\n1\n");
    const { io, out, calls } = terminal((request) =>
      request.method === "POST"
        ? Response.json({ id: "file_1" }, { status: 201 })
        : new Response("id\n2\n"),
    );

    expect(
      await run(
        [
          "raw-example",
          "upload",
          "--name",
          "in.csv",
          "--file",
          source,
          "--workspace",
          "acme",
        ],
        io,
      ),
    ).toBe(0);
    expect(calls[0].body).toBe("id\n1\n");
    expect(calls[0].request.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(out).toContain("id: file_1");

    const target = join(dir, "out.csv");
    expect(
      await run(
        [
          "raw-example",
          "download",
          "file_1",
          "--out",
          target,
          "--workspace",
          "acme",
        ],
        io,
      ),
    ).toBe(0);
    expect(new URL(calls[1].request.url).pathname).toBe(
      "/v1/files/file_1/content",
    );
    expect(readFileSync(target, "utf8")).toBe("id\n2\n");
    expect(out).toContain(`Saved to ${target}`);
  });
});
