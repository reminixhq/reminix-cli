# Changelog

What changed in the Reminix CLI (`@reminix/cli`). Generated from the source on each release; newest first.

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
