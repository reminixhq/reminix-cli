import { operationSurfaces, type OperationSurface } from "./surfaces.ts";

/**
 * The /v1 OPERATION TABLE: every operation with its surfaces (CLI command,
 * MCP tool — ./surfaces.ts) and its inputs (path, query and body fields,
 * typed and described), built from the OpenAPI document at BUILD time by
 * scripts/generate.mjs into ./operations.gen.ts (gitignored, like
 * v1.gen.ts). apps/cli turns each entry into a command; apps/mcp will turn
 * each into a tool — one table, so the two never drift. Deterministic: no
 * model anywhere.
 */
export type FieldType = "string" | "number" | "boolean" | "json";

export type OperationField = {
  name: string;
  in: "path" | "query" | "body";
  type: FieldType;
  required: boolean;
  description?: string;
  /** The route's example value, if it gives one (the docs' reference). */
  example?: unknown;
  /** The field's JSON Schema, `$ref`s inlined (an MCP tool's input). */
  schema: JsonSchema;
};

export type JsonSchema = Record<string, unknown>;

export type Operation = OperationSurface & {
  description: string;
  fields: OperationField[];
  /** Takes a JSON body. */
  hasBody: boolean;
  /**
   * Takes raw bytes as its body instead (a file upload): the media type
   * the route declares. The SDKs take the bytes as an argument, the CLI
   * a `--file`.
   */
  rawBody?: string;
  /**
   * Answers with raw bytes instead of JSON (a file download): the media
   * type. The SDKs return the bytes, the CLI writes them out.
   */
  rawResponse?: string;
  /** Acts in a workspace (sends X-Workspace with a personal token). */
  workspace: boolean;
  /** The scope the route requires (`x-scope`), if any. */
  scope?: string;
};

type Schema = {
  $ref?: string;
  example?: unknown;
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
};
type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
};
type Operations = Record<
  string,
  {
    description?: string;
    "x-scope"?: string;
    parameters?: Parameter[];
    requestBody?: {
      required?: boolean;
      content?: Record<string, { schema?: Schema }>;
    };
    responses?: Record<string, { content?: Record<string, unknown> }>;
  }
>;
type Document = {
  paths?: Record<string, Operations | undefined>;
  components?: { schemas?: Record<string, Schema> };
};

function resolve(document: Document, schema: Schema | undefined): Schema {
  if (!schema) return {};
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    return resolve(document, document.components?.schemas?.[name]);
  }
  return schema;
}

/** A schema with every `$ref` inlined — self-contained for a tool. */
function inline(document: Document, schema: unknown, depth = 0): JsonSchema {
  if (depth > 8 || schema === null || typeof schema !== "object") {
    return {};
  }
  const resolved = resolve(document, schema as Schema) as Record<
    string,
    unknown
  >;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [
          name,
          inline(document, property, depth + 1),
        ]),
      );
    } else if (
      (key === "items" || key === "additionalProperties") &&
      value &&
      typeof value === "object"
    ) {
      out[key] = inline(document, value, depth + 1);
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      out[key] = value.map((item) => inline(document, item, depth + 1));
    } else if (key !== "example") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A schema's example: its own, else, for an object, one built from its
 * properties' examples (required ones always, placeholders where a
 * required one has none) — so `subject: { kind, id }` reads
 * `{ kind: "user", id: "usr_123" }`, not `{}`.
 */
function exampleOf(
  document: Document,
  schema: Schema | undefined,
  depth = 0,
): unknown {
  if (!schema || depth > 4) return undefined;
  if (schema.example !== undefined) return schema.example;
  const resolved = resolve(document, schema);
  if (resolved.example !== undefined) return resolved.example;
  if (!resolved.properties) return undefined;
  const required = new Set(resolved.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(resolved.properties)) {
    const value = exampleOf(document, property, depth + 1);
    if (value !== undefined) out[name] = value;
    else if (required.has(name)) out[name] = `<${name}>`;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function fieldType(schema: Schema): FieldType {
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "string" || schema.enum) return "string";
  return "json";
}

export function buildOperations(document: Document): Operation[] {
  // The same document, read for its surfaces (names, hints) first.
  const surfaces = operationSurfaces(
    document as Parameters<typeof operationSurfaces>[0],
  );
  return surfaces.map((surface) => {
    const op = document.paths?.[surface.path]?.[surface.method] ?? {};
    const fields: OperationField[] = [];
    for (const parameter of op.parameters ?? []) {
      if (parameter.in !== "path" && parameter.in !== "query") continue;
      const schema = resolve(document, parameter.schema);
      const description = parameter.description ?? schema.description;
      const example = parameter.schema?.example ?? schema.example;
      fields.push({
        name: parameter.name,
        in: parameter.in,
        type: fieldType(schema),
        required: parameter.in === "path" || parameter.required === true,
        ...(description ? { description } : {}),
        ...(example !== undefined ? { example } : {}),
        schema: {
          ...inline(document, parameter.schema),
          ...(description ? { description } : {}),
        },
      });
    }
    const body = resolve(
      document,
      op.requestBody?.content?.["application/json"]?.schema,
    );
    const required = new Set(body.required ?? []);
    for (const [name, property] of Object.entries(body.properties ?? {})) {
      const schema = resolve(document, property);
      const example = exampleOf(document, property);
      fields.push({
        name,
        in: "body",
        type: fieldType(schema),
        required: required.has(name),
        ...(schema.description ? { description: schema.description } : {}),
        ...(example !== undefined ? { example } : {}),
        schema: inline(document, property),
      });
    }
    // A CLI argument must be one of the operation's fields (an `x-cli`
    // naming a field that was renamed would silently never be sent).
    const unknown = surface.cli.args.find(
      (arg) => !fields.some((field) => field.name === arg),
    );
    if (unknown) {
      throw new Error(
        `${surface.operationId}: the CLI argument "${unknown}" is not one of its fields`,
      );
    }
    // One flat input (CLI flags, MCP tool arguments): names must not
    // collide across path, query and body.
    const names = fields.map((field) => field.name);
    const duplicate = names.find((name, i) => names.indexOf(name) !== i);
    if (duplicate) {
      throw new Error(
        `${surface.operationId}: "${duplicate}" is both a parameter and a body field — rename one`,
      );
    }
    const bodyTypes = Object.keys(op.requestBody?.content ?? {});
    const rawBody = bodyTypes.includes("application/json")
      ? undefined
      : bodyTypes[0];
    const answerTypes = ["200", "201", "202"].flatMap((code) =>
      Object.keys(op.responses?.[code]?.content ?? {}),
    );
    const rawResponse =
      answerTypes.length > 0 && !answerTypes.includes("application/json")
        ? answerTypes[0]
        : undefined;
    return {
      ...surface,
      description: op.description ?? surface.summary,
      fields,
      hasBody: op.requestBody !== undefined && !rawBody,
      ...(rawBody ? { rawBody } : {}),
      ...(rawResponse ? { rawResponse } : {}),
      workspace: !(
        surface.path === "/user" || surface.path.startsWith("/user/")
      ),
      ...(op["x-scope"] ? { scope: op["x-scope"] } : {}),
    };
  });
}

export type OperationRequest = {
  method: string;
  /** The path under /v1, parameters filled in, query string included. */
  path: string;
  body?: Record<string, unknown>;
};

/**
 * One operation call as an HTTP request: path fields fill the path, query
 * fields the query string, body fields the JSON body (over `body`, a
 * whole body given up front). The ONE mapping the CLI and the MCP server
 * share. Throws when a path parameter is missing.
 */
export function operationRequest(
  op: Operation,
  input: Record<string, unknown>,
  body: Record<string, unknown> = {},
): OperationRequest {
  let path = op.path;
  const query = new URLSearchParams();
  const json = op.hasBody ? { ...body } : undefined;
  for (const field of op.fields) {
    const value = input[field.name];
    if (value === undefined) continue;
    if (field.in === "path") {
      path = path.replace(`{${field.name}}`, encodeURIComponent(String(value)));
    } else if (field.in === "query") {
      if (value !== null) query.set(field.name, String(value));
    } else if (json) {
      json[field.name] = value;
    }
  }
  const missing = path.match(/\{([^}]+)\}/);
  if (missing) throw new Error(`missing ${missing[1]}`);
  const qs = query.toString();
  return {
    method: op.method.toUpperCase(),
    path: qs ? `${path}?${qs}` : path,
    ...(json ? { body: json } : {}),
  };
}
