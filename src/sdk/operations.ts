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
  /** Takes a workspace API key; otherwise a person's token (OpenAPI `security`). */
  acceptsApiKey: boolean;
  /** The scope the route requires (`x-scope`), if any. */
  scope?: string;
  /** Marked `deprecated` in the OpenAPI document: still works, retiring. */
  deprecated?: boolean;
  /**
   * An either/or body (`oneOf`/`anyOf` of objects told apart by one
   * field): that field, and for each of its values the fields that value
   * requires. The flat field list holds every variant's fields, the
   * discriminator required and the rest optional; the API checks each
   * variant, and the CLI says which flags a value needs.
   */
  variants?: { field: string; required: Record<string, string[]> };
};

type Schema = {
  oneOf?: Schema[];
  anyOf?: Schema[];
  const?: unknown;
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
    deprecated?: boolean;
    security?: Record<string, unknown>[];
    parameters?: Parameter[];
    requestBody?: {
      required?: boolean;
      content?: Record<string, { schema?: Schema }>;
    };
    responses?: Record<string, { content?: Record<string, unknown> }>;
  }
>;
type Document = {
  security?: Record<string, unknown>[];
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
      const description =
        parameter.description ??
        schema.description ??
        (parameter.in === "path" ? pathDescription(parameter.name) : undefined);
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
    const union = bodyVariants(document, body);
    if (union) {
      for (const field of union.fields) fields.push(field);
    } else {
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
      acceptsApiKey:
        (op.security ?? document.security)?.some((s) => "apiKey" in s) ?? true,
      ...(op["x-scope"] ? { scope: op["x-scope"] } : {}),
      ...(op.deprecated ? { deprecated: true } : {}),
      ...(union ? { variants: union.variants } : {}),
    };
  });
}

/** The one value a schema allows (`const`, or an `enum` of one). */
function single(schema: Schema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1)
    return schema.enum[0];
  return undefined;
}

/**
 * An either/or body as one flat field list (2026-11-12: Reminix's
 * triggers are `{ type: "event", … } | { type: "webhook", … }`; the
 * first such body left the CLI with no flags and Python with no keyword
 * arguments). Every variant's fields, merged by name; the field every
 * variant fixes to one value is the discriminator, required, a choice of
 * those values; a field is required only if every variant requires it.
 */
function bodyVariants(
  document: Document,
  body: Schema,
):
  | {
      fields: OperationField[];
      variants: { field: string; required: Record<string, string[]> };
    }
  | undefined {
  const list = body.oneOf ?? body.anyOf;
  if (!Array.isArray(list) || list.length < 2) return undefined;
  const variants = list.map((v) => resolve(document, v));
  if (variants.some((v) => !v.properties)) return undefined;
  const discriminator = Object.keys(variants[0]!.properties!).find((name) =>
    variants.every((v) => {
      const p = v.properties?.[name];
      return p !== undefined && single(resolve(document, p)) !== undefined;
    }),
  );
  if (!discriminator) return undefined;
  const values = variants.map((v) =>
    single(resolve(document, v.properties![discriminator]!)),
  );
  const fields: OperationField[] = [];
  const seen = new Map<string, OperationField>();
  for (const variant of variants) {
    for (const [name, property] of Object.entries(variant.properties!)) {
      if (seen.has(name)) continue;
      const schema = resolve(document, property);
      const example = exampleOf(document, property);
      const isKey = name === discriminator;
      const field: OperationField = {
        name,
        in: "body",
        type: isKey ? "string" : fieldType(schema),
        required:
          isKey || variants.every((v) => (v.required ?? []).includes(name)),
        ...(schema.description ? { description: schema.description } : {}),
        ...(isKey
          ? { example: values[0] }
          : example !== undefined
            ? { example }
            : {}),
        schema: isKey
          ? {
              type: "string",
              enum: values,
              ...(schema.description
                ? { description: schema.description }
                : {}),
            }
          : inline(document, property),
      };
      seen.set(name, field);
      fields.push(field);
    }
  }
  const required = Object.fromEntries(
    variants.map((v, i) => [
      String(values[i]),
      (v.required ?? []).filter((name) => name !== discriminator),
    ]),
  );
  return { fields, variants: { field: discriminator, required } };
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
  // A `{param}` left unfilled — indexOf, not a regex (CodeQL
  // js/polynomial-redos).
  const open = path.indexOf("{");
  const close = open === -1 ? -1 : path.indexOf("}", open + 1);
  if (close > open + 1) {
    throw new Error(`missing ${path.slice(open + 1, close)}`);
  }
  const qs = query.toString();
  return {
    method: op.method.toUpperCase(),
    path: qs ? `${path}?${qs}` : path,
    ...(json ? { body: json } : {}),
  };
}

/**
 * What a path parameter is, when its route says nothing: named for what
 * it identifies (skills/api-design), `endpointId` reads "The endpoint's
 * ID." (QA pass, 2026-11-04: the reference listed them unexplained).
 */
export function pathDescription(name: string): string {
  const words = name
    .replace(/Id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return `The ${words}'s ID.`;
}
