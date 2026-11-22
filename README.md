# @reminix/cli

The Reminix CLI turns a script in a folder into a Reminix script, publishes it for your team and runs it, from a terminal, CI or another script.

[![A script published with reminix publish becomes a tool: Jordan asks Claude for a refund, Sam approves it in Reminix, and the refund goes out.](https://media.reminix.com/launch/readme-20261117-1555.gif)](https://reminix.com/#demo)

[▶ Watch the 1-minute demo](https://reminix.com/#demo)

Reminix turns your scripts into internal tools. Upload a Python, shell or Node script, and Reminix runs it from a form, the API, the CLI or your AI agents, on a schedule or from a webhook. Keys stay out of the code, and every run is on record.

## Install

```bash
npm install -g @reminix/cli
```

Or run it without installing: `npx @reminix/cli --help`.

## Sign in

```bash
reminix login
```

Your browser opens: sign in, choose the workspaces the CLI may use, keep
the access at **Publish and run scripts**, and click **Allow**. On a server or in CI, set `REMINIX_TOKEN` to a personal
access token instead.

## Publish a script and run it

In the script's folder, here `monthly-report`, publish it for your
team. Reminix works out how it runs from the folder. Each `{name}` in
the command becomes an input, optional inside `[ … ]`:

```bash
reminix publish --command "python report.py [--month {month}]"
```

Then anyone on the team can run it from the app's form, through the
API, as an agent tool, or here:

```bash
reminix run monthly-report -f month=2026-09 --out ./reports
```

## Everything else

Every API operation is a command: `reminix --help` lists them, and any
command takes `--json` for the API's exact answer, for scripts and
agents.

## Links

- [Website](https://reminix.com)
- [CLI guide](https://reminix.com/docs/cli/)
- [API reference](https://reminix.com/docs/reference/)
- [Changelog](https://github.com/reminixhq/reminix-cli/blob/main/CHANGELOG.md)
- [Discord](https://reminix.com/discord)
- [Report a security issue](https://reminix.com/security/)

## Contributing

This repository is generated from Reminix's source on each
release, so pull requests are ported there and credited (see
[CONTRIBUTING.md](https://github.com/reminixhq/reminix-cli/blob/main/CONTRIBUTING.md)).

## License

Licensed under the Apache License 2.0.
