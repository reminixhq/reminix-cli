import type { OperationField } from "./sdk/operations.gen.ts";

/**
 * How an operation's field becomes flags (owner, 2026-11-22: the CLI
 * follows CLI conventions, as gh and the Stripe CLI do), read by the
 * generated commands (./generated.ts) and the docs' samples:
 *
 * - a list of strings or numbers is one flag per value, named in the
 *   singular: `--event-type a --event-type b` (commas work too:
 *   `--event-type a,b`);
 * - a boolean is `--x` to turn it on and `--no-x` to turn it off;
 * - a body field that can be null also takes `--clear-<field>`, which
 *   sends null;
 * - anything else is `--x <value>`, and an object `--x <json>`.
 */
export type FlagKind = "value" | "json" | "boolean" | "list";

export type FieldFlag = {
  /** The flag without its dashes: `event-type`. */
  name: string;
  kind: FlagKind;
  /** The list's items are numbers. */
  numbers?: boolean;
  /** Takes `--clear-<field>`, sending null: the field's own name, kebab-cased. */
  clear?: string;
};

/** `eventTypes` → `event-types`. */
export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** commander's camelCase key for a --kebab-case option. */
export function optionKey(flagName: string): string {
  return flagName.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** A plural English word's singular, for the common endings. */
export function singular(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(x|ch|sh|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

type Schema = {
  type?: string | string[];
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  nullable?: boolean;
};

function types(schema: Schema | undefined): string[] {
  if (!schema) return [];
  const own = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  const variants = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  return [
    ...own,
    ...variants.flatMap(types),
    ...(schema.nullable ? ["null"] : []),
  ];
}

/** Whether the field's schema takes null. */
export function nullable(field: OperationField): boolean {
  return types(field.schema as Schema).includes("null");
}

/**
 * The flag for one field. `taken` holds the other fields' flag names:
 * a list keeps its plural name when its singular is another field's.
 */
export function fieldFlag(
  field: OperationField,
  taken: ReadonlySet<string> = new Set(),
): FieldFlag {
  const schema = field.schema as Schema;
  const name = kebab(field.name);
  const clear = field.in === "body" && nullable(field) ? name : undefined;
  const base = { ...(clear ? { clear } : {}) };
  if (field.type === "boolean") return { name, kind: "boolean", ...base };
  const all = types(schema);
  const items =
    schema.items ?? [...(schema.anyOf ?? [])].find((s) => s.items)?.items;
  const itemTypes = types(items);
  const scalar =
    itemTypes.length > 0 &&
    itemTypes.every((t) => ["string", "number", "integer"].includes(t));
  if (all.includes("array") && (scalar || Array.isArray(items?.enum))) {
    const words = name.split("-");
    const one = [...words.slice(0, -1), singular(words.at(-1)!)].join("-");
    return {
      name: one !== name && taken.has(one) ? name : one,
      kind: "list",
      ...(itemTypes.every((t) => t === "number" || t === "integer")
        ? { numbers: true }
        : {}),
      ...base,
    };
  }
  return { name, kind: field.type === "json" ? "json" : "value", ...base };
}

/** The flags a sample shows for a field set to `value` (the docs' examples). */
export function sampleFlags(
  field: OperationField,
  value: unknown,
  taken?: ReadonlySet<string>,
): string[][] {
  const spec = fieldFlag(field, taken);
  if (value === null && spec.clear) return [[`--clear-${spec.clear}`]];
  if (spec.kind === "boolean") {
    return [[value === false ? `--no-${spec.name}` : `--${spec.name}`]];
  }
  if (spec.kind === "list" && Array.isArray(value)) {
    return value.map((item) => [`--${spec.name}`, String(item)]);
  }
  return [
    [
      `--${spec.name}`,
      typeof value === "string" ? value : JSON.stringify(value),
    ],
  ];
}
