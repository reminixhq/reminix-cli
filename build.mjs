// Bundles the CLI (with the SDK and commander) into one file, so the
// published package has no runtime dependencies.
import { build } from "esbuild";

const { version } = JSON.parse(
  await import("node:fs").then((fs) => fs.readFileSync("package.json", "utf8")),
);
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/reminix.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  define: { "process.env.CLI_VERSION": JSON.stringify(version) },
  logLevel: "warning",
});
