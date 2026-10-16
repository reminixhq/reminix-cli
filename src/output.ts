/** Plain-text tables and JSON — no colors, no terminal tricks; pipes stay clean. */
export function table(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  const cell = (value: unknown) =>
    value === null || value === undefined ? "" : String(value);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cell(row[column]).length)),
  );
  const line = (values: string[]) =>
    values
      .map((value, i) => value.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [
    line(columns),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join("\n");
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
