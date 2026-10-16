import { parse as parseToml } from "smol-toml";

/**
 * PUBLISH WITHOUT reminix.json (docs/product/design-publish.md): what a
 * plain folder says about how to run it — its name, its command and the
 * inputs that command names. Pure, so the API runs it on an uploaded
 * folder ("Upload a version" without a `command`) and the CLI runs the
 * same code for `reminix publish --plan`, offline. Narrow and solid: a
 * Python, Node or shell script in the common layouts; anything else, or
 * two candidates, is a clear refusal saying what was found and what to
 * add — never a guess.
 */

/** The folder, as far as detection needs it. */
export type Folder = {
  /** Every file's path relative to the folder (`src/app/__main__.py`). */
  files: string[];
  /** A small text file's contents, or null when absent. */
  read: (path: string) => string | null;
  /** Whether a file is executable (mode bits), when known. */
  executable?: (path: string) => boolean;
  /** The folder's own name, when known (the CLI knows it; an upload doesn't). */
  name?: string;
};

export type Detected = {
  /** What decided it: `pyproject.toml`, `package.json`, or a file name. */
  source: string;
  kind: "python" | "node" | "shell";
  slug?: string;
  name?: string;
  description?: string;
  command: string;
};

export type Detection =
  { ok: true; value: Detected } | { ok: false; error: string };

const SCRIPT = /\.(py|js|mjs|cjs|ts|mts|sh)$/i;
const NOT_A_SCRIPT =
  /(\.config\.|^setup\.py$|^conftest\.py$|\.d\.ts$|\.test\.|_test\.py$|^test_)/i;

const HELP =
  'Pass --command "…" (for example --command "python report.py {month}"), add a reminix.json, or ask your agent to write one.';

/** `@acme/monthly-report` or `Monthly_Report` → `monthly-report`. */
export function slugOf(name: string): string | undefined {
  const slug = name
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : undefined;
}

/** `monthly-report` → `Monthly report`. */
export function titleOf(slug: string): string {
  const words = slug.split("-").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const program = (file: string) => {
  if (/\.py$/i.test(file))
    return { kind: "python" as const, run: `python ${file}` };
  if (/\.sh$/i.test(file)) return { kind: "shell" as const, run: `sh ${file}` };
  return { kind: "node" as const, run: `node ${file}` };
};

const quoted = (word: string) =>
  /^[\w./@:-]+$/.test(word) ? word : `"${word}"`;

/** The folder's top-level script, by the rules in the design. */
function scriptFile(folder: Folder): Detection | null {
  const top = folder.files.filter((f) => !f.includes("/"));
  const scripts = top.filter((f) => SCRIPT.test(f) && !NOT_A_SCRIPT.test(f));
  if (scripts.length === 1) {
    const p = program(scripts[0]!);
    return {
      ok: true,
      value: { source: scripts[0]!, kind: p.kind, command: p.run },
    };
  }
  for (const entry of [
    "main.py",
    "__main__.py",
    "index.js",
    "index.mjs",
    "index.ts",
    "main.sh",
    "run.sh",
  ]) {
    if (scripts.includes(entry)) {
      const p = program(entry);
      return {
        ok: true,
        value: {
          source: entry,
          kind: p.kind,
          command: entry === "__main__.py" ? "python ." : p.run,
        },
      };
    }
  }
  if (scripts.length === 0) {
    // One executable file with a #! line and no extension: run it as is.
    const shebang = top.filter(
      (f) =>
        !f.includes(".") &&
        (folder.executable?.(f) ?? true) &&
        (folder.read(f) ?? "").startsWith("#!"),
    );
    if (shebang.length === 1) {
      return {
        ok: true,
        value: {
          source: shebang[0]!,
          kind: "shell",
          command: `./${shebang[0]}`,
        },
      };
    }
    return null;
  }
  return {
    ok: false,
    error: `Several script files here (${scripts.join(", ")}) and none is the entry (main.py, index.js, run.sh). ${HELP}`,
  };
}

type Project = { name?: string; description?: string };

function fromPyproject(
  folder: Folder,
  text: string,
): Detection | { project: Project } {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      error: `pyproject.toml is not valid TOML: ${(error as Error).message}`,
    };
  }
  const project = (doc.project ?? {}) as Record<string, unknown>;
  const info: Project = {
    name: typeof project.name === "string" ? project.name : undefined,
    description:
      typeof project.description === "string" ? project.description : undefined,
  };
  const scripts = Object.entries(
    (project.scripts ?? {}) as Record<string, unknown>,
  ).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (scripts.length > 1) {
    return {
      ok: false,
      error: `pyproject.toml has several [project.scripts] (${scripts.map(([k]) => k).join(", ")}). ${HELP}`,
    };
  }
  if (scripts.length === 1) {
    const [, target] = scripts[0]!;
    const match = /^\s*([\w.]+)\s*:\s*([\w.]+)\s*$/.exec(target);
    if (!match) {
      return {
        ok: false,
        error: `pyproject.toml: can't read the script entry "${target}". ${HELP}`,
      };
    }
    const [, module, attr] = match;
    const [first, ...rest] = attr!.split(".");
    const call = [first, ...rest].join(".");
    return {
      ok: true,
      value: {
        source: "pyproject.toml",
        kind: "python",
        ...info,
        command: `python -c ${quoted(`import sys; from ${module} import ${first}; sys.exit(${call}())`)}`,
      },
    };
  }
  // A package with __main__.py, at the top or under src/: `python -m`.
  const mains = [
    ...new Set(
      folder.files
        .map((f) => /^(?:src\/)?([A-Za-z_]\w*)\/__main__\.py$/.exec(f)?.[1])
        .filter((m): m is string => !!m),
    ),
  ];
  if (mains.length === 1) {
    return {
      ok: true,
      value: {
        source: "pyproject.toml",
        kind: "python",
        ...info,
        command: `python -m ${mains[0]}`,
      },
    };
  }
  if (mains.length > 1) {
    return {
      ok: false,
      error: `Several packages with __main__.py (${mains.join(", ")}). ${HELP}`,
    };
  }
  return { project: info };
}

function fromPackageJson(text: string): Detection | { project: Project } {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      error: `package.json is not valid JSON: ${(error as Error).message}`,
    };
  }
  const info: Project = {
    name: typeof pkg.name === "string" ? pkg.name : undefined,
    description:
      typeof pkg.description === "string" ? pkg.description : undefined,
  };
  const value = (command: string): Detection => ({
    ok: true,
    value: { source: "package.json", kind: "node", ...info, command },
  });
  const bin =
    typeof pkg.bin === "string"
      ? [pkg.bin]
      : Object.values((pkg.bin ?? {}) as Record<string, unknown>).filter(
          (v): v is string => typeof v === "string",
        );
  if (bin.length > 1) {
    return {
      ok: false,
      error: `package.json has several "bin" entries (${bin.join(", ")}). ${HELP}`,
    };
  }
  if (bin.length === 1) return value(`node ${bin[0]!.replace(/^\.\//, "")}`);
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  if (typeof scripts.start === "string") return value("npm start");
  if (typeof pkg.main === "string")
    return value(`node ${pkg.main.replace(/^\.\//, "")}`);
  return { project: info };
}

/**
 * How to run the folder. Order: pyproject.toml, then package.json, then
 * the folder's own script; the name comes from the project file, else
 * the folder's name.
 */
export function detectScript(folder: Folder): Detection {
  let project: Project = {};
  for (const [file, read] of [
    ["pyproject.toml", fromPyproject.bind(null, folder)],
    ["package.json", fromPackageJson],
  ] as const) {
    const text = folder.read(file);
    if (text === null) continue;
    const result = read(text);
    if ("ok" in result) return withName(result, folder);
    project = { ...result.project, ...project };
  }
  const script = scriptFile(folder);
  if (!script) {
    return {
      ok: false,
      error: `No script found here: no pyproject.toml or package.json that names one, and no single .py, .js, .ts or .sh file. ${HELP}`,
    };
  }
  return withName(
    script.ok ? { ok: true, value: { ...project, ...script.value } } : script,
    folder,
  );
}

function withName(result: Detection, folder: Folder): Detection {
  if (!result.ok) return result;
  const slug =
    (result.value.name && slugOf(result.value.name)) ??
    (folder.name ? slugOf(folder.name) : undefined);
  const name = slug ? titleOf(slug) : undefined;
  return {
    ok: true,
    value: {
      ...result.value,
      ...(slug ? { slug } : {}),
      ...(name ? { name } : {}),
    },
  };
}

/** An input for each `{name}` in the command: required unless inside `[ … ]`. */
export function inputSchemaForCommand(command: string) {
  const optional = new Set(
    [...command.matchAll(/\[[^\]]*\]/g)].flatMap((group) =>
      [...group[0].matchAll(/\{([A-Za-z_][\w-]*)\}/g)].map((m) => m[1]!),
    ),
  );
  const names = [
    ...new Set(
      [...command.matchAll(/\{([A-Za-z_][\w-]*)\}/g)].map((m) => m[1]!),
    ),
  ];
  return {
    type: "object",
    required: names.filter((name) => !optional.has(name)),
    properties: Object.fromEntries(
      names.map((name) => [name, { type: "string" }]),
    ),
  };
}
