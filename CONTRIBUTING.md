# Contributing

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for your interest! This repo keeps its contributor documentation inside
the docs set:

- [docs/development.md](docs/development.md) — the constraints that shape every
  change (zero dependencies, DSH-knowledge layering, stdout discipline), how to
  add a slash command, and the release checklist.
- [docs/testing.md](docs/testing.md) — test policy, fixtures, and the manual
  acceptance checklist.
- [docs/dsh-compat.md](docs/dsh-compat.md) — every assumption about DeepSeek
  Harness, each with a verification command. New assumption → new row, same
  commit.

Ground rules:

1. `npm test` green before and after your change (pure Node, no network).
2. Code and docs change in the same commit; a behavior change without its doc
   update is an incomplete change.
3. No npm dependencies. If a change seems to need one, it probably belongs in
   DeepSeek Harness itself.

## Before opening a change

1. Search existing issues and pull requests.
2. For a behavior change, open an issue first so scope and compatibility can be agreed before implementation.
3. Do not disclose vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).

## Development workflow

```bash
git clone https://github.com/cpj-dev/dsh-plugin-cc.git
cd dsh-plugin-cc
npm test
```

The project intentionally has no runtime or development dependencies, so there is no install step. Use a focused branch, keep changes small, and add or update tests for behavior changes.

## Documentation and localization

- English is the canonical technical source. Simplified Chinese mirrors the user, contributor, support, security, and conduct entry points.
- Update the English source and its Chinese counterpart in the same pull request when user-visible behavior changes.
- Keep command names, flags, environment variables, paths, JSON keys, status values, and log excerpts in English.
- Keep private implementation notes under ignored paths such as `/.internal/` or `/implementation-notes.md`; public design decisions belong in `docs/`.

## Pull requests

- Explain the problem, the chosen approach, and compatibility impact.
- Link the related issue when one exists.
- Include test evidence and note any manual checks.
- Keep unrelated refactors out of the same change.
- Confirm that no credentials, local paths, generated output, or private notes are included.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
