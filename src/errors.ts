/**
 * The CLI's exit codes (owner, 2026-11-22; Unix's convention, as grep
 * and bash use 2 for wrong usage):
 *
 *   0  success
 *   1  a failure: the API refused the call, the network failed, …
 *   2  wrong usage: an unknown command or flag, a missing or invalid one
 *   4  not logged in, or the API refused the credential (401)
 *
 * A product may add its own (Limitry's refused `check`) from 5 up.
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 4,
} as const;

/** The command was used wrongly (exit code 2): say how to use it. */
export class UsageError extends Error {
  readonly exitCode: number = EXIT.usage;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** No credential to call the API with (exit code 4). */
export class NotLoggedInError extends Error {
  readonly exitCode: number = EXIT.auth;
  constructor(message: string) {
    super(message);
    this.name = "NotLoggedInError";
  }
}
