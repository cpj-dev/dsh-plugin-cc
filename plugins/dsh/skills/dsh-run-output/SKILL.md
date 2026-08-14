---
name: dsh-run-output
description: Internal guidance for presenting DeepSeek Harness bridge results (reviews, critiques, delegated runs) back to the user. Read before summarizing any dsh-bridge.mjs output.
---

# Presenting dsh run output

The bridge renders final text intended for the user. Presentation rules:

1. Show the bridge's rendered output verbatim — do not paraphrase findings or re-rank severities. Your own assessment, when the user asks for it, goes after the verbatim output and is clearly attributed to you.
2. Always preserve the footer metadata line (`run: <id> · dsh session: <id> · mode: ...`). The run id is how the user gets back to this result; the session id is how they continue it.
3. For background starts, the only content that matters is the run id and the "check /dsh:runs" pointer. Keep it to one short paragraph.
4. For failures, show the error message and the log path, then a one-line diagnosis of whether the failure is environmental (missing dsh, credentials, profile) or task-level (the model's turn failed). Suggest `/dsh:check` only for environmental failures.
5. A critique rendered as "unstructured output" means the JSON contract failed but the review text is intact — present it as a normal review and note the formatting miss in one clause, not a paragraph.
6. Never dump raw JSON (`--json` payloads) at the user unless they asked for JSON.
7. Keep bridge output verbatim so run IDs, diagnostics, commands, paths, and status values remain exact. When the user's language is not English, add any explanation in the user's language after the verbatim block; do not translate machine-facing values.
