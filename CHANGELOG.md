# Changelog

What changed in the Reminix CLI (`@reminix/cli`). Generated from the source on each release; newest first.

## 1.0.0-rc.8 (2026-11-07)

### Added

- `reminix files download <file-id> --json` prints the file's details and
  where it was saved, like every other command's `--json`.
- A `run.cancelled` webhook event, sent when a run is cancelled: by
  someone (`runs.cancel`), or because its approval was denied, expired or
  couldn't start. Its `data` is the same as `run.failed`'s, with `error`
  saying why. Triggers can start a script on it.
- Each plan now limits how many runs a workspace has going at once: 1 on
  Free, 5 on Pro and 15 on Business, short and long runs together. Of
  those, at most 2 can be long runs on Pro and 5 on Business. Starting
  one more answers `429 rate_limited` with a `Retry-After` header (a few
  seconds for a short run, 30 for a long one) instead of running; the
  SDKs and the CLI wait and try again on their own.
- You can now change a webhook endpoint's URL, description or event types
  without deleting it: `client.workspace.webhookEndpoints.update()`
  (`PATCH /v1/workspace/webhook-endpoints/{endpointId}`). The endpoint
  keeps its signing secret, so your verification code keeps working.

### Changed

- An AI agent connected through the MCP server can no longer change who
  may run a script or which of its runs need approval:
  `PATCH /v1/scripts/{slug}` (`scripts.update`) answers `403 forbidden`
  when an agent's token sends `access`, `teamIds` or `approvalPolicy`.
  People's own tokens and API keys change them as before. And with
  `approvalPolicy: "always"`, an agent's run now always waits for
  approval, even when an owner or admin connected the agent.
- An approval request (`POST /v1/workspace/approval-requests`) now runs in
  the environment it was filed in once a person approves it, such as live
  when you asked from live. Before, it ran in the default environment
  unless its input named one. Requests filed before this change still
  run in the default.
- The descriptions of every method and command are rewritten to be easier
  to read: one rule per sentence, with nothing about how calls behave
  changed. They now also say that only workspace owners can manage webhook
  endpoints with a personal access token.
  Every response in the API reference now comes with an example of what
  it returns.
- Error messages and CLI output read as whole sentences: what went wrong,
  then what to do. For example, an unknown environment now says
  `Unknown environment "staging". This product's environments are test, live.`
  Error codes are unchanged, so code that checks `error.code` keeps
  working. Code that matches the exact text of a message may need
  updating.
- One name per idea, across the API, the SDKs, the CLI and MCP (breaking,
  before 1.0):

  - Upload a version is `scriptVersions.upload` (`script_versions.upload`
    in Python), and takes `source` (was `archive`), `install` (was
    `build`), `timeoutSeconds` (was `timeout`) and `envVars` (was `env`).
    A version answers with `version` (was `number`), `install`,
    `installLog`, `buildBytes`, `buildSha256`, `envVars` and `via` (was
    `createdVia`); version paths are `/versions/{version}`.
  - Test-run a version is `scriptVersions.testRun` (`test_run`).
  - A run has `via` (was `interface`; an agent's runs are `agent`, was
    `mcp`) and `startedBy: { userId, name, credential: { type, name } }`.
    Its log is `runs.log` at `GET /v1/runs/{runId}/log` (was `runs.logs`,
    `/logs`). The 202 schema is `RunAwaitingApproval` (was `HeldRun`).
  - A file has `origin` (`input` or `saved`, was `direction` `in`/`out`),
    `input` (was `field`) and `mediaType` (was `type`); list files with
    `?origin=`. `files.upload` and `files.download` (at
    `GET /v1/files/{fileId}/download`) replace `files.create` and
    `files.content`. The SDKs' `FileUpload` takes `mediaType`
    (`media_type` in Python). A script saves files to `/saved`
    (`$REMINIX_SAVED`, was `/outputs`), and reads its inputs file at
    `$REMINIX_INPUTS_FILE` (was `$REMINIX_INPUTS`).
  - Secrets: `allowEnvVar` (was `allowEnv`; the CLI's `--allow-env-var`),
    a secret use's `format` (was `value`), and `secretValues.delete`
    (`reminix secret-values delete`, was `secrets.unset`).
  - Triggers have `lastRunAt` (was `lastFiredAt`); a script's
    `usedBy.startsScripts` was `followedBy`; an environment's `usedBy` was
    `usage`. The event `run.succeeded` was `run.completed`. Script ids
    start `scr_`.
  - The CLI: `reminix upload [dir...]` uploads a draft (`publish --draft`
    is gone), and `--dry-run` replaces `--plan`.
- Path parameters such as `endpointId` and `deliveryId` now come with a
  description ("The endpoint's ID.") in the SDKs' type hints, the
  command line's help and the API reference.
- `login` and `logout` now point to **Account → Personal access tokens**,
  the page's new name in the app (it was "API tokens").
- The API reference's "Too many requests" answer now gives the limit: 100
  requests a minute for each credential, whether an API key, a personal
  access token or an agent's sign-in. Wait the number of seconds in the
  `Retry-After` header before trying again.
- Method and command descriptions are clearer, and say who can call each
  one. A workspace API key's access to updating, archiving, restoring and
  test-running scripts is now stated. The CLI's `reminix publish`,
  `reminix upload` and `reminix run` shortcuts describe themselves the
  same way as the full commands.
- Error messages are easier to read. Each one states the problem in one
  sentence, then what to do in the next:

  ```text
  SHOP_KEY has no value in staging. Add it in Settings → Scripts.
  ```

  If your code matches the text of an error, match its `code` instead.
  The codes haven't changed.
- Environments and secrets now live under **Settings → Scripts** in the
  app. A run error that sends you to the app to fix a secret or an
  environment now names that tab.
- A run's `output`, `error` and log (`GET /v1/runs/{id}`,
  `GET /v1/runs/{id}/log`) never show a secret value the run had access
  to: printed as it is, or base64- or URL-encoded, it reads `[secret]`.
- API keys and webhooks now live together under **Settings → Developers**
  in the app, and the descriptions of the API key and webhook endpoint
  operations point there.
- `POST /v1/scripts/{slug}/runs` no longer fails a run because no machine
  was free at once: the run waits up to 2 minutes for one, and its
  `timeoutSeconds` counts from when its code starts. A short run still
  answers `200` when it ends within 60 seconds; one still going then
  answers `202` with status `running`, like a long run, and you follow it
  with `GET /v1/runs/{id}`.
- `GET /v1/workspace/usage` returns its list as `counts` instead of `meters`.
  Update anything that reads `meters` from `client.workspace.usage.get()`, the
  Python client or the CLI's output.

### Fixed

- `files.upload` refuses a file over the plan's size with `402
  plan_limit_reached`, naming the plan's limit, on every plan. On Pro and
  Business a file just over 100 MB used to get a generic `413` instead.
- Clearer, corrected descriptions for Reminix's operations in the API
  reference, the SDKs' type hints, the command line's help and the MCP
  tools:

  - `runs.create` (and `scriptVersions.testRun`) documents its 429: 100
    requests a minute per key or token, or the plan's runs at once all
    going. Its 402 now also names used-up long-run minutes and a file
    input larger than the plan takes, and its 400 an archived script. A
    run takes at most its version's `timeoutSeconds`, not always 30.
  - `runs.cancel` says a cancelled run sends a `run.cancelled` event, and
    that a workspace API key may cancel too.
  - `files.upload` documents its 413: uploads over 1,000 MB are refused.
    An upload can be given to one run.
  - `files.get`: an upload not yet used is also readable by owners,
    admins and workspace API keys.
  - `scripts.update`: its 402 is about every-run approval (Business), and
    it changes tags too. `scriptSettings.update`: its 402 is about
    second-person publishing (Business).
  - `schedules.update` and `triggers.update`: `enabled` no longer claims a
    default; leaving it out keeps it as it is.
  - Name rules are given where they are checked: a script's `slug`, its
    tags, an environment's `name`, a secret's `name`, and a secret's
    `value` (at most 16,384 bytes).
- A run that waited for approval now reports when it actually started:
  its `startedAt` (`GET /v1/runs/{id}`, and a run wherever the SDKs and
  the CLI show one) is when it was approved, not when it was requested, and a cancelled long run's
  `durationMs` counts only the time it ran, never the wait.

## 1.0.0-rc.7 (2026-10-19)

### Changed

- - `reminix run` waits through a person's approval, as the SDKs' `run`
    does: it prints where to approve the run, then follows it to the end.
    `--no-wait` answers at once instead.
  - A cancelled run says why, in every client: "Run run_… was cancelled:
    The approval was denied" (the run's `error`). The CLI no longer prints
    "failed: null".
  - Files are uploaded without a guessed type; the API takes it from the
    file's name, the same way for every client. `reminix run --file` no
    longer reads the script first: one file is sent as one id, and the API
    takes it for an input that is a list of files.
  - Publishing is one call. `scriptVersions.create` (Upload a version)
    takes `create`, `name`, `description` and `publish`: it can make a new
    script, rename one, and publish the upload, answering with an
    `approval` link when a person must approve. Without `readme`, the
    folder's `README.md` is used. `reminix publish` uses it, so a name or
    description changed in `reminix.json` now reaches the script.
  - `reminix init` works out the command the same way `publish` does, so
    the two agree on every folder (an entry like `main.py` beside other
    scripts, `pyproject.toml`, `package.json`).

## 1.0.0-rc.6 (2026-10-19)

### Fixed

- `login` in the browser no longer shows Safari's "This is a non-secure
  form" warning after **Allow**. The page now hands the new token back to
  the waiting CLI encrypted to a key only that CLI holds, by a redirect
  instead of a form. A CLI from before this change is asked to update.
- `reminix run <slug> --number <n>` test-runs version n (a draft).
  `--version <n>` printed the CLI's own version instead of running, so it
  is gone. A run whose output is text prints it as it is, without quotes.

## 1.0.0-rc.5 (2026-10-16)

No user-facing changes.

## 1.0.0-rc.4 (2026-10-16)

### Added

- Each release comes with a `CHANGELOG.md` listing what changed, newest first.

### Changed

- The package page (README, on GitHub, npm and PyPI) shows what the product does with a first real example, and links the guide, the API reference, the changelog and support.

## 1.0.0-rc.3 (2026-10-16)

No user-facing changes.
