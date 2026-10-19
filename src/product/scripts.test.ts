import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brand } from "../brand/index.ts";
import { describe, expect, it } from "vitest";

import { run, type Io } from "../cli.ts";
import { loadScriptDir } from "./scripts.ts";

const PAT = `pat_${brand.identifier}_abcdefghijklmnop`;

function scriptDir(command: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cap-"));
  writeFileSync(
    join(dir, "reminix.json"),
    JSON.stringify({
      slug: "refund-customer",
      name: "Refund a customer",
      command,
      inputSchema: {
        type: "object",
        required: ["orderId"],
        properties: { orderId: { type: "string" } },
      },
      hosts: ["api.stripe.com"],
      secrets: {
        STRIPE_KEY: {
          host: "api.stripe.com",
          header: "Authorization",
          value: "Bearer {secret}",
        },
      },
      timeout: 120,
    }),
  );
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

/** The names in a .tar.gz (the system's tar). */
function listed(archive: Buffer): string[] {
  const out = spawnSync("tar", ["-tzf", "-"], { input: archive });
  return out.stdout
    .toString()
    .split("\n")
    .filter((line) => line && !line.endsWith("/"))
    .map((line) => line.replace(/^\.\//, ""))
    .sort();
}

describe("loadScriptDir", () => {
  it("packs the folder's files, without installed dependencies, caches or .env", () => {
    const dir = scriptDir("python refund.py {orderId}", {
      "refund.py": "print('ok')\n",
      "lib/helpers.py": "X = 1\n",
      "requirements.txt": "requests==2.32.3\n",
      ".env": "STRIPE_KEY=sk_live_nope\n",
      "node_modules/x/index.js": "",
      ".venv/bin/python": "",
      "__pycache__/refund.cpython-312.pyc": "",
    });
    const { manifest, archive, files } = loadScriptDir(dir);
    expect(manifest.command).toBe("python refund.py {orderId}");
    expect(files).toEqual([
      "lib/helpers.py",
      "refund.py",
      "reminix.json",
      "requirements.txt",
    ]);
    expect(archive[0]).toBe(0x1f);
    expect(listed(archive)).toEqual(files);
  });

  it("reads the README beside reminix.json", () => {
    const dir = scriptDir("sh run.sh {orderId}", { "run.sh": "echo hi\n" });
    expect(loadScriptDir(dir).readme).toBeNull();
    writeFileSync(join(dir, "README.md"), "# Refunds\n");
    expect(loadScriptDir(dir).readme).toBe("# Refunds\n");
  });

  it("leaves a command reminix.json doesn't give to the API, showing what the folder says", () => {
    const dir = scriptDir("", { "run.sh": "" });
    const { manifest, detected } = loadScriptDir(dir);
    expect(manifest.command).toBeUndefined();
    expect(detected?.command).toBe("sh run.sh");
  });

  it("reads a folder with no reminix.json: its pyproject.toml names and runs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "plain-"));
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nname = "monthly-report"\ndescription = "The month."\n',
    );
    writeFileSync(join(dir, "report.py"), "print(1)\n");
    const { manifest, detected } = loadScriptDir(dir);
    expect(manifest).toMatchObject({
      slug: "monthly-report",
      name: "Monthly report",
      description: "The month.",
    });
    expect(manifest.command).toBeUndefined();
    expect(detected).toMatchObject({
      source: "report.py",
      command: "python report.py",
    });
  });

  it("takes --command, --name and --slug over the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "plain-"));
    writeFileSync(join(dir, "a.py"), "");
    writeFileSync(join(dir, "b.py"), "");
    expect(() => loadScriptDir(dir)).toThrow(
      /Several script files here \(a\.py, b\.py\)/,
    );
    const { manifest, detected } = loadScriptDir(dir, {
      command: "python b.py {day}",
      name: "Daily",
      slug: "daily",
    });
    expect(manifest).toMatchObject({
      slug: "daily",
      name: "Daily",
      command: "python b.py {day}",
    });
    expect(detected).toBeNull();
  });
});

/** A fake API for publish: scripts are missing until created; `failing` 500s. */
function publishTerminal(
  options: { failing?: string; approval?: boolean } = {},
) {
  const calls: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: { [`${brand.identifier.toUpperCase()}_TOKEN`]: PAT },
    homeDir: mkdtempSync(join(tmpdir(), "cap-home-")),
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const path = new URL(req.url).pathname;
      const text = req.method === "GET" ? "" : await req.text();
      const body = text
        ? (JSON.parse(text) as Record<string, unknown>)
        : undefined;
      calls.push({ method: req.method, path, body });
      if (options.failing && path.includes(`/${options.failing}/versions`)) {
        return Response.json(
          { error: { code: "invalid_request", message: "Bad manifest" } },
          { status: 400 },
        );
      }
      if (req.method === "GET") {
        return Response.json(
          { error: { code: "not_found", message: "No such script" } },
          { status: 404 },
        );
      }
      if (path.endsWith("/versions"))
        return Response.json(
          body?.publish && options.approval
            ? {
                number: 3,
                published: false,
                approval: { approveUrl: "https://app.example/approvals/a_1" },
              }
            : { number: 3, published: body?.publish === true },
          { status: 201 },
        );
      if (path.endsWith("/publish"))
        return Response.json(
          options.approval
            ? { approval: { approveUrl: "https://app.example/approvals/a_1" } }
            : { publishedVersion: 3 },
        );
      return Response.json({}, { status: 201 });
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: async () => "",
  };
  const routes = () => calls.map((c) => `${c.method} ${c.path}`);
  return { io, calls, out, err, routes };
}

/** A script folder with this slug inside `parent`. */
function scriptIn(parent: string, slug: string) {
  const dir = join(parent, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "reminix.json"),
    JSON.stringify({
      slug,
      name: slug,
      command: "sh run.sh",
      inputSchema: { type: "object" },
    }),
  );
  writeFileSync(join(dir, "run.sh"), "echo hi\n");
  return dir;
}

describe("publish", () => {
  it("creates the script when missing, uploads a version and publishes it by default", async () => {
    const dir = scriptDir("python refund.py {orderId}", {
      "refund.py": "print('ok')\n",
    });
    const t = publishTerminal();
    const code = await run(
      ["scripts", "publish", dir, "--workspace", "acme", "--json"],
      t.io,
    );
    expect(t.err).toEqual([]);
    expect(code).toBe(0);
    // One call: created if missing, named as reminix.json says, published.
    expect(t.routes()).toEqual(["POST /v1/scripts/refund-customer/versions"]);
    expect(t.calls[0].body).toMatchObject({
      command: "python refund.py {orderId}",
      build: null,
      timeout: 120,
      via: "cli",
      hosts: ["api.stripe.com"],
      secrets: {
        STRIPE_KEY: { host: "api.stripe.com", header: "Authorization" },
      },
      create: true,
      name: "Refund a customer",
      publish: true,
    });
    // The README goes in the folder: the API reads it there.
    expect(t.calls[0].body).not.toHaveProperty("readme");
    expect(
      listed(Buffer.from(String(t.calls[0].body?.archive), "base64")),
    ).toEqual(["refund.py", "reminix.json"]);
    expect(JSON.parse(t.out.join("\n"))).toMatchObject({
      version: { number: 3 },
    });
  });

  it("is the same command as `scripts publish`: same calls, same output", async () => {
    const dir = scriptDir("sh run.sh", { "run.sh": "echo hi\n" });
    const long = publishTerminal();
    const short = publishTerminal();
    expect(
      await run(["scripts", "publish", dir, "--workspace", "acme"], long.io),
    ).toBe(0);
    expect(await run(["publish", dir, "--workspace", "acme"], short.io)).toBe(
      0,
    );
    expect(short.routes()).toEqual(long.routes());
    expect(short.out).toEqual(long.out);
    expect(short.out).toEqual(["Published refund-customer version 3."]);
  });

  it("uploads a draft with --draft, and publishes nothing", async () => {
    const dir = scriptDir("sh run.sh", { "run.sh": "echo hi\n" });
    const t = publishTerminal();
    expect(
      await run(["publish", dir, "--draft", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.calls[0].body).toMatchObject({ publish: false });
    expect(t.out).toEqual([
      `Uploaded refund-customer version 3 as a draft. Publish it in the app, or run \`${brand.name} publish\` again without --draft.`,
    ]);
  });

  it("says publishing waits when the workspace requires a person's approval", async () => {
    const dir = scriptDir("sh run.sh", { "run.sh": "echo hi\n" });
    const t = publishTerminal({ approval: true });
    expect(await run(["publish", dir, "--workspace", "acme"], t.io)).toBe(0);
    expect(t.out).toEqual([
      "Uploaded refund-customer version 3; publishing waits for a person's approval: https://app.example/approvals/a_1",
    ]);
  });

  it("publishes several folders, one line each", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-many-"));
    const a = scriptIn(root, "monthly-report");
    const b = scriptIn(root, "nightly-sync");
    const t = publishTerminal();
    expect(await run(["publish", a, b, "--workspace", "acme"], t.io)).toBe(0);
    expect(t.out).toEqual([
      "Published monthly-report version 3.",
      "Published nightly-sync version 3.",
    ]);
  });

  it("publishes every subfolder with a reminix.json when given their parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-parent-"));
    scriptIn(root, "unlock-account");
    scriptIn(root, "alert-on-failure");
    mkdirSync(join(root, "notes"));
    const t = publishTerminal();
    expect(
      await run(["publish", root, "--draft", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.routes().filter((r) => r.endsWith("/versions"))).toEqual([
      "POST /v1/scripts/alert-on-failure/versions",
      "POST /v1/scripts/unlock-account/versions",
    ]);
    expect(t.routes().some((r) => r.endsWith("/publish"))).toBe(false);
  });

  it("publishes plain script subfolders too, and says which it skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-plain-"));
    scriptIn(root, "unlock-account");
    mkdirSync(join(root, "report"));
    writeFileSync(join(root, "report", "report.py"), "print(1)\n");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "README.md"), "# notes\n");
    // A helper at the top doesn't make the parent one script.
    writeFileSync(join(root, "helpers.py"), "x = 1\n");
    const t = publishTerminal();
    expect(
      await run(["publish", root, "--draft", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.routes().filter((r) => r.endsWith("/versions"))).toEqual([
      "POST /v1/scripts/report/versions",
      "POST /v1/scripts/unlock-account/versions",
    ]);
    expect(t.err).toContain(`Skipped ${join(root, "notes")}: no script in it`);
  });

  it("publishes a project as one script, whatever its subfolders hold", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "cap-project-")), "sync-tool");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "sync-tool", bin: { sync: "./bin/sync.js" } }),
    );
    writeFileSync(join(root, "scripts", "build.js"), "console.log(1)\n");
    const t = publishTerminal();
    expect(
      await run(["publish", root, "--draft", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.routes().filter((r) => r.endsWith("/versions"))).toEqual([
      "POST /v1/scripts/sync-tool/versions",
    ]);
  });

  it("carries on past a failure, then fails naming it", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-fail-"));
    for (const slug of ["a-first", "b-broken", "c-last"]) scriptIn(root, slug);
    const t = publishTerminal({ failing: "b-broken" });
    expect(await run(["publish", root, "--workspace", "acme"], t.io)).toBe(1);
    expect(t.out).toEqual([
      "Published a-first version 3.",
      "Published c-last version 3.",
    ]);
    expect(t.err).toContain(`${join(root, "b-broken")}: Bad manifest`);
    expect(t.err.at(-1)).toBe(
      `${brand.name}: 1 of 3 failed: ${join(root, "b-broken")}`,
    );
  });

  it("fails on a folder with no script in it or below", async () => {
    const t = publishTerminal();
    const empty = mkdtempSync(join(tmpdir(), "cap-empty-"));
    expect(await run(["publish", empty, "--workspace", "acme"], t.io)).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.err.join("\n")).toContain("No script found");
  });

  it("publishes a plain folder, leaving the command to the API", async () => {
    const t = publishTerminal();
    const dir = join(mkdtempSync(join(tmpdir(), "cap-")), "nightly_sync");
    mkdirSync(dir);
    writeFileSync(join(dir, "sync.mjs"), "console.log(1)\n");
    expect(await run(["publish", dir, "--workspace", "acme"], t.io)).toBe(0);
    expect(t.routes()).toEqual(["POST /v1/scripts/nightly-sync/versions"]);
    const upload = t.calls[0];
    expect(upload.body).toMatchObject({ create: true, publish: true });
    // Worked out, not set: the API names it (and never renames it later).
    expect(upload.body).not.toHaveProperty("name");
    expect(upload.body).not.toHaveProperty("command");
    expect(upload.body).not.toHaveProperty("inputSchema");
    expect(t.out.join("\n")).toContain("Node script (sync.mjs)");
  });

  it("publishes the version you tested with --number, uploading nothing", async () => {
    const t = publishTerminal();
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    writeFileSync(join(dir, "report.py"), "");
    expect(
      await run(
        [
          "publish",
          dir,
          "--slug",
          "report",
          "--number",
          "2",
          "--workspace",
          "acme",
        ],
        t.io,
      ),
    ).toBe(0);
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/scripts/report/versions/2/publish",
    ]);
    expect(t.out.join("\n")).toContain("Published report version 2.");
    const bad = publishTerminal();
    expect(
      await run(
        ["publish", dir, "--number", "2", "--draft", "--workspace", "acme"],
        bad.io,
      ),
    ).toBe(1);
    expect(bad.calls).toEqual([]);
  });

  it("shows the plan and uploads nothing with --plan", async () => {
    const t = publishTerminal();
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    writeFileSync(join(dir, "report.py"), "");
    expect(
      await run(["publish", dir, "--plan", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.out.join("\n")).toMatch(
      /command {2}python report\.py[\s\S]*Nothing was uploaded/,
    );
  });
});

describe("scripts run", () => {
  function terminal(run: Record<string, unknown>) {
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
      homeDir: mkdtempSync(join(tmpdir(), "cap-home-")),
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const path = new URL(req.url).pathname;
        const text = req.method === "GET" ? "" : await req.text();
        const environment = req.headers.get("x-environment");
        calls.push({
          method: req.method,
          path,
          body: text ? JSON.parse(text) : undefined,
          ...(environment ? { environment } : {}),
        });
        if (path.endsWith("/logs"))
          return Response.json({ lines: ["one", "two"] });
        return Response.json(run);
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      stdin: async () => "",
    };
    return { io, calls, out, err };
  }

  it("runs with the inputs and prints the output; --log prints the log", async () => {
    const t = terminal({
      id: "run_1",
      status: "succeeded",
      output: { ok: true },
      error: null,
    });
    const code = await run(
      [
        "scripts",
        "run",
        "refund-customer",
        "--input",
        '{"orderId":"o_1"}',
        "--log",
        "--workspace",
        "acme",
      ],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.calls[0]).toEqual({
      method: "POST",
      path: "/v1/scripts/refund-customer/runs",
      body: { inputs: { orderId: "o_1" }, via: "cli" },
    });
    expect(JSON.parse(t.out.join("\n"))).toEqual({ ok: true });
    expect(t.err).toEqual(["one", "two"]);
  });

  it("is the same command as `run`: same calls, same output", async () => {
    const succeeded = {
      id: "run_1",
      status: "succeeded",
      output: { ok: true },
      error: null,
    };
    const args = ["refund-customer", "--input", '{"orderId":"o_1"}', "--log"];
    const long = terminal(succeeded);
    const short = terminal(succeeded);
    expect(
      await run(["scripts", "run", ...args, "--workspace", "acme"], long.io),
    ).toBe(0);
    expect(await run(["run", ...args, "--workspace", "acme"], short.io)).toBe(
      0,
    );
    expect(short.calls).toEqual(long.calls);
    expect(short.out).toEqual(long.out);
    expect(short.err).toEqual(long.err);
  });

  it("--number test-runs that version, and text output prints as it is", async () => {
    const t = terminal({
      id: "run_3",
      status: "succeeded",
      output: "hello ['--name', 'umair']",
      error: null,
    });
    // Through the shortcut and the CLI's root, where `--version` would
    // print the CLI's version instead of running.
    expect(
      await run(["run", "hello", "--number", "2", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.calls[0]?.path).toBe("/v1/scripts/hello/versions/2/runs");
    expect(t.out).toEqual(["hello ['--name', 'umair']"]);
  });

  it("waits through a person's approval, and says why a run was cancelled", async () => {
    const answers = [
      {
        id: "run_4",
        status: "awaiting_approval",
        output: null,
        error: null,
        approval: { approveUrl: "https://app.example/approvals/apr_1" },
      },
      {
        id: "run_4",
        status: "cancelled",
        output: null,
        error: "The approval was denied",
      },
    ];
    const t = terminal({});
    const fetch = t.io.fetch;
    t.io.fetch = async (input, init) => {
      await fetch(input, init);
      return Response.json(answers.shift() ?? answers[0]);
    };
    expect(await run(["run", "x", "--workspace", "acme"], t.io)).not.toBe(0);
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/scripts/x/runs",
      "GET /v1/runs/run_4",
    ]);
    expect(t.err.join("\n")).toContain(
      "Waiting for a person's approval (run run_4): https://app.example/approvals/apr_1",
    );
    expect(t.err.join("\n")).toContain(
      "The run was cancelled (run_4): The approval was denied",
    );
  });

  it("--no-wait answers at once with a held run", async () => {
    const t = terminal({ id: "run_5", status: "awaiting_approval" });
    expect(
      await run(["run", "x", "--no-wait", "--workspace", "acme"], t.io),
    ).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.out).toEqual(["Run run_5 is awaiting_approval."]);
  });

  it("fails on a failed run and on inputs that are not a JSON object", async () => {
    const failed = terminal({
      id: "run_2",
      status: "failed",
      output: null,
      error: "boom",
    });
    expect(
      await run(["scripts", "run", "x", "--workspace", "acme"], failed.io),
    ).not.toBe(0);
    expect(failed.err.join("\n")).toContain("The run failed (run_2): boom");
    const bad = terminal({});
    expect(
      await run(
        ["scripts", "run", "x", "--input", "[1]", "--workspace", "acme"],
        bad.io,
      ),
    ).not.toBe(0);
    expect(bad.calls).toEqual([]);
  });
});

describe("scripts run in an environment", () => {
  it("runs in the environment --environment names, following and logging there too", async () => {
    const calls: { path: string; environment: string | null }[] = [];
    const err: string[] = [];
    let polls = 0;
    const io: Io = {
      env: { [`${brand.identifier.toUpperCase()}_TOKEN`]: PAT },
      homeDir: mkdtempSync(join(tmpdir(), "cap-home-")),
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const path = new URL(req.url).pathname;
        const environment = req.headers.get("x-environment");
        calls.push({ path, environment });
        const headers = { "x-environment": environment ?? "production" };
        if (path.endsWith("/logs"))
          return Response.json({ lines: [] }, { headers });
        const status =
          path.endsWith("/runs") || polls++ > 0 ? "succeeded" : "running";
        return Response.json(
          { id: "run_9", status, output: { ok: 1 }, error: null },
          { headers },
        );
      },
      stdout: () => {},
      stderr: (line) => err.push(line),
      stdin: async () => "",
    };
    const code = await run(
      [
        "--environment",
        "staging",
        "scripts",
        "run",
        "refund-customer",
        "--log",
        "--workspace",
        "acme",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => c.environment === "staging")).toBe(true);
    expect(err).toContain("Environment: staging");
  });
});
