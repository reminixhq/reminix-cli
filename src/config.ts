import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { brand } from "./brand/index.ts";
import { DEFAULT_API } from "@reminix/sdk";

import { tokenEnvVar } from "./cli.ts";

/**
 * ~/.config/<name>/config.json — the API origin, the personal access token,
 * the default workspace and the default environment (the product's —
 * test, live …). Written 0600 (the directory 0700): the token is a
 * credential. The token may instead come from the shell (<NAME>_TOKEN),
 * which always wins — CI and scripts never write the file.
 */
export type CliConfig = {
  api?: string;
  token?: string;
  workspace?: string;
  environment?: string;
};

/** The variable naming the environment to act in (PLATFORM_ENVIRONMENT, LIMITRY_ENVIRONMENT, …). */
export function environmentEnvVar(): string {
  return `${brand.identifier.toUpperCase()}_ENVIRONMENT`;
}

export function configPath(homeDir: string): string {
  return join(homeDir, ".config", brand.name, "config.json");
}

export function readConfig(homeDir: string): CliConfig {
  const path = configPath(homeDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    throw new Error(`${path} is not valid JSON — fix or delete it`);
  }
}

export function writeConfig(homeDir: string, config: CliConfig): void {
  const path = configPath(homeDir);
  mkdirSync(join(homeDir, ".config", brand.name), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export type Settings = {
  api: string;
  token: string | undefined;
  workspace: string | undefined;
  /**
   * The environment to act in, sent as X-Environment: `--environment`
   * over <NAME>_ENVIRONMENT over the file. Unset, the API acts in the
   * product's default (and a product without environments ignores it).
   */
  environment: string | undefined;
  /** Where `environment` came from. */
  environmentSource: "flag" | "env" | "config" | null;
};

/** Effective settings: flag over shell variable over file over defaults (the API origin from @repo/sdk). */
export function resolveSettings(
  env: Record<string, string | undefined>,
  homeDir: string,
  flags: { environment?: string } = {},
): Settings {
  const config = readConfig(homeDir);
  const environment: Pick<Settings, "environment" | "environmentSource"> =
    flags.environment
      ? { environment: flags.environment, environmentSource: "flag" }
      : env[environmentEnvVar()]
        ? { environment: env[environmentEnvVar()], environmentSource: "env" }
        : config.environment
          ? { environment: config.environment, environmentSource: "config" }
          : { environment: undefined, environmentSource: null };
  return {
    ...environment,
    api: (
      env[`${brand.identifier.toUpperCase()}_API`] ??
      config.api ??
      DEFAULT_API
    ).replace(/\/+$/, ""),
    token: env[tokenEnvVar()] ?? config.token,
    workspace:
      env[`${brand.identifier.toUpperCase()}_WORKSPACE`] ?? config.workspace,
  };
}
