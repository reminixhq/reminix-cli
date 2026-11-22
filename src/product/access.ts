import { brand } from "../brand/index.ts";

/**
 * What to do when the API refuses a request for a scope the token
 * wasn't granted (the onboarding walkthrough, 2026-11-20: `reminix
 * login` then `reminix publish` said only "This credential is not
 * granted the scripts:write scope"). A token from `login` gets a new
 * grant by signing in again; the quick choice that covers scripts and
 * runs is named, and anything else needs Full access.
 */
export function productErrorHint(error: {
  code?: string;
  message: string;
}): string | null {
  if (error.code !== "forbidden") return null;
  const scope = /not granted the ([a-z_]+:[a-z]+) scope/.exec(
    error.message,
  )?.[1];
  if (!scope) return null;
  const choice = /^(scripts|runs):/.test(scope)
    ? "Publish and run scripts"
    : "Full access";
  return `Sign in again with \`${brand.name} login\` and choose ${choice}.`;
}
