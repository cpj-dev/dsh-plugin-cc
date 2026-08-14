# Documentation index

[English](README.md) | [简体中文](zh-CN/README.md)

This documentation set is layered for progressive disclosure: each layer answers one class of question and links down, never up. Add facts at the shallowest layer where they matter; one home per fact.

## Layers and reading order

| Layer | Document | Question it answers | Update when |
|---|---|---|---|
| 0 | [../README.md](../README.md) | What is this, how do I install and invoke it? | commands or scope change |
| 1 | [commands.md](commands.md) | Exact semantics and flags of every `/dsh:*` command | any user-visible behavior change |
| 1 | [troubleshooting.md](troubleshooting.md) | How do I recover from setup or runtime failures? | diagnostics or recovery steps change |
| 2 | [architecture.md](architecture.md) | How the bridge is built and why | drive paths, process model, or design decisions change |
| 2 | [dsh-compat.md](dsh-compat.md) | Which DSH behaviors we depend on, verified against which version | **every dsh upgrade — re-verify first** |
| 3 | [broker.md](broker.md) | Broker internals: wire protocol, lifecycle, failure modes | broker or SDK protocol changes |
| 3 | [state-and-jobs.md](state-and-jobs.md) | Durable state layout and the job lifecycle | state.mjs / tracked-jobs.mjs changes |
| 4 | [development.md](development.md) | How to change this repo (add a command, release) | conventions change |
| 4 | [testing.md](testing.md) | Test policy, fixtures, manual acceptance | test infrastructure changes |

## Conventions for this doc set

- Current-state prose only: documents describe what the code does now, never the history of how it got there.
- Every claim about DeepSeek Harness behavior cites [dsh-compat.md](dsh-compat.md) instead of restating it — that file is the single re-verification point on upgrades.
- Code and docs change in the same commit. A behavior change without its doc update is an incomplete change.
- Keep layer discipline: command flags belong in commands.md, not architecture.md; DSH facts belong in dsh-compat.md, not scattered in code comments (code comments may summarize and link).

## Languages and source of truth

- English files at their existing paths are canonical technical sources.
- Simplified Chinese user documentation lives under [zh-CN/](zh-CN/README.md). It mirrors onboarding, command, troubleshooting, contribution, security, and conduct workflows; deep implementation documents link back to English instead of creating a second technical contract.
- Command names, flags, environment variables, paths, JSON keys, status values, and log excerpts are never translated.
- When user-visible behavior changes, update the English source and its Chinese counterpart in the same pull request. Each Chinese page records its synchronization date.

## Public and private documentation

Contributor guides, test policy, architecture, and compatibility contracts are public project documentation and stay version-controlled. Local implementation notes, review output, release drafts, and exploratory plans belong in `/.internal/`, `/docs/internal/`, `/docs/plans/`, or `/implementation-notes.md`; those paths are intentionally ignored.
