import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "../brand/index.ts";
import { describe, expect, it } from "vitest";

import { run, type Io } from "../cli.ts";
import { outputPath, typeOf } from "./files.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;

/** A terminal against a fake API: records requests, answers by route. */
function terminal(answer: (request: Request, path: string) => Response) {
  const requests: {
    method: string;
    path: string;
    body: string;
    type: string | null;
  }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { [`${brand.identifier.toUpperCase()}_TOKEN`]: PAT },
    homeDir: mkdtempSync(join(tmpdir(), "cap-home-")),
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname + url.search;
      requests.push({
        method: request.method,
        path,
        body: request.method === "GET" ? "" : await request.clone().text(),
        type: request.headers.get("content-type"),
      });
      return answer(request, path);
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: async () => "",
  };
  return { io, requests, out, err };
}

const file = (id: string, name: string, direction: "in" | "out") => ({
  id,
  name,
  type: "text/csv",
  size: 3,
  direction,
  runId: "run_1",
  field: direction === "in" ? "statement" : null,
  sha256: null,
  createdAt: "2026-10-08T00:00:00Z",
  expiresAt: "2026-10-15T00:00:00Z",
  downloadUrl: direction === "out" ? `https://files.example/${id}` : null,
});

describe("scripts run with files", () => {
  it("uploads each --file first, runs with the ids, and saves --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-"));
    writeFileSync(join(dir, "sept.csv"), "a,b");
    const out = join(dir, "results");
    let uploads = 0;
    const t = terminal((_request, path) => {
      if (path.startsWith("/v1/files?")) {
        uploads++;
        return Response.json({ id: `file_up${uploads}` }, { status: 201 });
      }
      if (path === "/v1/scripts/convert") {
        return Response.json({
          inputSchema: {
            properties: {
              statement: { type: "string", format: "file" },
              extras: { type: "array" },
            },
          },
        });
      }
      if (path === "/v1/scripts/convert/runs") {
        return Response.json({
          id: "run_1",
          status: "succeeded",
          output: { rows: 1 },
          error: null,
          files: [
            file("file_up1", "sept.csv", "in"),
            file("file_out", "out/sept.ofx", "out"),
          ],
        });
      }
      if (path === "/v1/files/file_out/content") {
        return new Response("OFX", {
          headers: { "content-type": "application/x-ofx" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const code = await run(
      [
        "scripts",
        "run",
        "convert",
        "--input",
        '{"account":"acme"}',
        "--file",
        `statement=${join(dir, "sept.csv")}`,
        "--file",
        `extras=${join(dir, "sept.csv")}`,
        "--out",
        out,
        "--workspace",
        "acme",
      ],
      t.io,
    );
    expect(t.err.filter((l) => !l.startsWith("Saved"))).toEqual([]);
    expect(code).toBe(0);
    const upload = t.requests.find((r) => r.path.startsWith("/v1/files?"))!;
    expect(upload).toMatchObject({
      method: "POST",
      path: "/v1/files?name=sept.csv",
      body: "a,b",
      type: "text/csv",
    });
    const started = t.requests.find(
      (r) => r.path === "/v1/scripts/convert/runs",
    )!;
    expect(JSON.parse(started.body)).toEqual({
      inputs: { account: "acme", statement: "file_up1", extras: ["file_up2"] },
      via: "cli",
    });
    expect(readFileSync(join(out, "out", "sept.ofx"), "utf8")).toBe("OFX");
    expect(t.err).toContain(`Saved ${join(out, "out", "sept.ofx")}`);
    expect(t.out).toEqual([JSON.stringify({ rows: 1 }, null, 2)]);
  });

  it("prints where to get what it wrote, without --out", async () => {
    const t = terminal(() =>
      Response.json({
        id: "run_2",
        status: "succeeded",
        output: null,
        error: null,
        files: [file("file_o", "report.csv", "out")],
      }),
    );
    expect(
      await run(["scripts", "run", "report", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.err).toEqual(["Wrote report.csv: https://files.example/file_o"]);
  });

  it("explains a --file that isn't input=path", async () => {
    const t = terminal(() => Response.json({}));
    expect(
      await run(
        ["scripts", "run", "x", "--file", "sept.csv", "--workspace", "a"],
        t.io,
      ),
    ).not.toBe(0);
    expect(t.err.join("\n")).toMatch(/input=path/);
  });
});

describe("files", () => {
  it("upload prints the new file's id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-"));
    writeFileSync(join(dir, "data.json"), "{}");
    const t = terminal(() => Response.json({ id: "file_9" }, { status: 201 }));
    expect(
      await run(
        ["files", "upload", join(dir, "data.json"), "--workspace", "a"],
        t.io,
      ),
    ).toBe(0);
    expect(t.out).toEqual(["file_9"]);
    expect(t.requests[0].type).toBe("application/json");
  });

  it("never saves an output outside the folder", () => {
    expect(outputPath("/tmp/out", "a/b.csv")).toBe("/tmp/out/a/b.csv");
    expect(() => outputPath("/tmp/out", "../evil.sh")).toThrow(
      /not a path inside/,
    );
    expect(typeOf("x.PDF")).toBe("application/pdf");
    expect(typeOf("x.bin")).toBe("application/octet-stream");
  });
});
