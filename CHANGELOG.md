# Changelog

What changed in the Reminix CLI (`@reminix/cli`). Generated from the source on each release; newest first.

## 1.0.0-rc.14 (2026-11-22)

### Added

- You can now read one schedule, one trigger or one secret at its own
  address: `GET /v1/scripts/{slug}/schedules/{scheduleId}`,
  `GET /v1/scripts/{slug}/triggers/{triggerId}` and `GET /v1/secrets/{name}`.
  In the SDKs they're `schedules.get`, `triggers.get` and `secrets.get`,
  in the CLI `reminix schedules get`, `triggers get` and `secrets get`, and
  the MCP server has a tool for each. A secret's value is never returned.
- Everything you create now answers with a `Location` header that gives
  its address: a script, a version, a schedule, a trigger, an environment,
  a file and a run. One version of a script can now be read at
  `GET /v1/scripts/{slug}/versions/{version}` (`scriptVersions.get`).
- Reminix is here: turn your scripts into tools your team, your software
  and your AI agents can run.

  Upload a Python, shell or Node script, and Reminix runs it. Start a run
  from a form in the app, from the API or from the CLI. A
  script can also run on a schedule, or when another service calls its
  webhook. Your agents in Claude and ChatGPT can find your scripts and run
  them for you.

  Each run gets its own isolated machine. Your keys stay out of the code:
  Reminix adds each one only to the hosts you allow, and the script never
  sees it.

  Where a run needs a person's yes, Reminix asks for it before the run
  starts. Every run is on record, with its inputs, its output and who
  started it.

  When a run waits for your approval or fails, Reminix tells you in the
  app, by email or with a push notification to your phone.
- Every TypeScript SDK call now takes a `timeout` in milliseconds and a
  `signal`, for example `client.limits.list({}, { timeout: 2000 })`. The
  timeout covers the whole call, retries and their waits included. Past
  it, the call throws a `TimeoutError` and isn't retried. To set one for
  every call, pass `timeout` to `createClient`.

  An `ApiError` now carries the response's `headers`, so you can read
  `Retry-After` and the rate-limit headers when a call fails.

### Changed

- Every list command takes `--all`, to print every page instead of the
  first.

  A list field now takes its flag once for each value, such as
  `--event-type a --event-type b`. Commas work too:
  `--event-type a,b`. A yes-or-no field takes `--x` and `--no-x`, and a
  field you can empty takes `--clear-<field>`.

  `--base-url`, or the `<NAME>_BASE_URL` variable, points the CLI at
  another API address. They replace `login --api` and `<NAME>_API`.

  The exit code now says how a command ended: `1` a failure, `2` a wrong
  command or flag, and `4` when you aren't signed in or the API refused
  your token. An error also prints what is wrong with each field and a
  link to its docs, and with `--json` it carries both.
- `reminix run` takes its inputs the way `gh api` takes fields.
  `-f name=value` gives a text input, and `-F name=value` gives a number,
  `true`, `false`, `null` or JSON. `--input-file` reads the whole object
  from a file, or from standard input with `-`. They replace
  `--input '<json>'`.
- A request that clashes with what already exists now answers
  `409 conflict`, which was `400 invalid_request`. That covers a script
  slug or an environment name already taken, a field set in the script's
  reminix.json, running an archived script, and cancelling a run that
  has ended. In the SDKs it's a `ConflictError`.
- Every list now pages the same way. A script's versions, schedules,
  triggers and trigger calls, and the workspace's secrets and environments,
  take `limit` and `cursor` and answer `{ items, nextCursor }`, as runs and
  files already did. A trigger's calls are no longer cut at the last 20.
- A script's `stats` now name their period in full: `runsLast30Days` and
  `peopleLast30Days`, which were `runs30d` and `people30d`.
- A secret's value is now saved at its own address:
  `PUT /v1/secrets/{name}/values/{environment}`, the same address that
  removes it. In the SDKs it's `secretValues.set(name, environment, …)`.
  Whether scripts can read a secret as an environment variable is set on
  the secret itself, with `PATCH /v1/secrets/{name}` (`secrets.update`).
  `reminix secrets set` works as before, and `--no-allow-env-var` now
  turns that off again.
- A file's size is now `sizeBytes`, which was `size`. The file details a
  script reads from its inputs JSON say `sizeBytes` too.
- Listing a webhook trigger's calls is now `triggerCalls.list()` in the
  TypeScript SDK, `trigger_calls.list()` in Python, `reminix trigger-calls
  list` in the CLI and the `trigger_calls_list` tool in the MCP server. It
  was `triggers.calls`. The route is unchanged.
- A script's name, description and tags now belong to its `reminix.json`
  when the file sets them. Each upload sets them from the file, and they
  can't be changed in the app or with `PATCH /v1/scripts/{slug}`. The app
  shows such tags as "Set in reminix.json". To change one, edit the file
  and publish again, or remove it from the file to manage it in the app.

  A script's new `setInFile` field lists the settings its `reminix.json`
  sets.

  An AI agent changing a script through the MCP server gets the same
  answer.

## 1.0.0-rc.13 (2026-11-18)

No user-facing changes.

## 1.0.0-rc.12 (2026-11-14)

No user-facing changes.

## 1.0.0-rc.11 (2026-11-13)

No user-facing changes.

## 1.0.0-rc.10 (2026-11-12)

No user-facing changes.

## 1.0.0-rc.9 (2026-11-07)

No user-facing changes.

## 1.0.0-rc.8 (2026-11-07)

No user-facing changes.

## 1.0.0-rc.7 (2026-10-19)

No user-facing changes.

## 1.0.0-rc.6 (2026-10-19)

No user-facing changes.

## 1.0.0-rc.5 (2026-10-16)

No user-facing changes.

## 1.0.0-rc.4 (2026-10-16)

No user-facing changes.

## 1.0.0-rc.3 (2026-10-16)

No user-facing changes.
