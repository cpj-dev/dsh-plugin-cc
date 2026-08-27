# Development

## Constraints that shape every change

- **Zero npm dependencies.** Plugin scripts run under whatever Node the user has (>= 20) with no install step; both reference plugins (Codex, Grok Build) made the same choice and it is why `/plugin install` just works. Hand-roll small things; if a change seems to need a dependency, it probably belongs in DSH itself.
- **DSH knowledge stays in two files.** `scripts/lib/dsh.mjs` (CLI composition) and `scripts/dsh-broker.mjs` (SDK wire). Any other file needing a DSH fact indicates a layering leak.
- **Every DSH assumption is a row in [dsh-compat.md](dsh-compat.md)** with a verification command. New assumption → new row, same commit.
- **Third-party provenance goes in [NOTICE](../NOTICE).** Mechanism ports, research citations, and architectural inspiration are named there with the correct license and URL in the same commit. Do not guess MIT. See CONTRIBUTING.md ground rule 4.
- **stdout discipline.** Bridge stdout is user-facing rendered text (or `--json` payloads); progress goes to stderr and the job log. Broker-runtime stdout is JSON-RPC only — never add a stdout logger to the `cc` profile.
- **Windows one-shot is supported** (spawn `node` + `lib/bin.js`, never `.cmd` / `shell: true`). The broker (unix sockets) and `terminateProcessTree` (`pgrep`) remain POSIX.

## Adding a slash command

1. Add the subcommand handler in `scripts/dsh-bridge.mjs` (parse with `parseCommandInput`, render via `lib/render.mjs`, wrap execution in a tracked job if it runs DSH).
2. Add `plugins/dsh/commands/<name>.md` — frontmatter `description` + the exact bridge invocation + presentation guidance for Claude.
3. Document the flags in [commands.md](commands.md) and the one-line summary in the root README table.
4. Add a test (fake-dsh fixture for anything that spawns DSH) and, if the command needs new presentation rules, extend the `dsh-run-output` skill.

## Iteration guardrails

- User-visible wording lives in `commands/*.md` and `lib/render.mjs`; behavior lives in the bridge/libs. Change them in separate commits when possible — wording changes should be safe to ship alone.
- The managed `cc` profile patch block is versioned by its marker comment; if the block's content must change, add migration handling in `handleSetup` (detect the old block, replace it), because existing users already have the old text on disk.
- **Every pull request that changes `plugins/` or `.claude-plugin/` bumps the version.** `main` is the distribution channel: `/plugin install` takes whatever `main` holds, unpacks it into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and records that version in `installed_plugins.json`. Bumping only "on release" means every intermediate build claims to be the previous release — which is how `1.0.0` came to cover a dozen different trees, `/plugin` stopped being able to tell them apart, and a bug report could not name what it was filed against. `tests/version.test.mjs` checks that the four manifests agree and that the changelog leads with that version; the `version` CI job fails a pull request that ships plugin code without raising the number. There is no `Unreleased` changelog section — write the entry under the version you are shipping.
- Mount-time code in `lib/tool-bootstrap.mjs` is load-bearing for two modes at once, and `--dump-config` composes rows **without ever calling a plugin's `apply()`** — only a real run catches a mount failure there. See the boot smoke in [testing.md](testing.md) item 15.

## Release checklist

1. `npm test` green.
2. Manual acceptance checklist in [testing.md](testing.md) against the pinned dsh version.
3. Docs synced (README tables, commands.md, dsh-compat.md pin). NOTICE still names every third-party source with the correct license.
4. English and Simplified Chinese user-entry pages synced; relative links and community templates checked.
5. `CHANGELOG.md` entry finalized under the shipping version's heading, recording the pinned `@deepseek-ai/dsh` npm version used for acceptance.
6. Version bumps (plugin.json, marketplace.json ×2, package.json) land **in** the shipping pull request, not after it; tag `v<version>` on `main` once merged.
