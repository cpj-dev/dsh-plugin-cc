# Security

[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

## Supported versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting at
https://github.com/cpj-dev/dsh-plugin-cc/security/advisories/new. Include
the affected version, reproduction steps, impact, and any suggested fix. Do
not disclose exploitable details in a public issue, discussion, or pull request
before a coordinated fix ships.

Maintainers aim to acknowledge a report within three business days and provide
an initial assessment within seven business days. Timelines vary with severity
and maintainer availability; status updates stay in the private advisory.

## Security model, in brief

- **Credentials.** The plugin never reads or transmits your `DEEPSEEK_API_KEY`
  itself; it only probes *where* one exists (env, `$DSH_HOME/.credentials.yaml`,
  `.env`) so `/dsh:check` can report readiness. The key is consumed by the
  DeepSeek Harness processes the plugin spawns. `.env` files are gitignored
  here; keep them out of your own repos too.
- **Sandboxing.** Every dsh invocation runs under an explicit
  `DSH_PERMISSION_MODE`: reviews/critiques are always `read-only`; tasks
  default to `read-only` and require `--write` for `workspace-write`. The
  plugin never uses `danger-full-access`. The unattended overlay disables
  dsh's interactive approvals, so the sandbox mode is the real boundary.
- **Detached processes.** Background runs and the per-workspace broker are
  detached processes that outlive the Claude session. `/dsh:runs --all`,
  `/dsh:stop`, and `/dsh:stop --broker` enumerate and terminate them; the
  SessionEnd hook cancels the session's own runs.
- **No network access in the bridge.** The bridge scripts spawn local
  processes only; all network traffic happens inside dsh (model API) or in
  commands you run yourself (e.g. `git clone`).

## Disclosure and credit

After a fix is available, maintainers will coordinate disclosure and release
notes with the reporter. Reporters are credited when requested unless doing so
would expose sensitive information.
