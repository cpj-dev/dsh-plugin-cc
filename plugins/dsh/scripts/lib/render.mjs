/** Plain-text renderers for bridge stdout (returned verbatim to the user). */

function statusIcon(ok) {
  return ok ? "✓" : "✗";
}

/** Render the `check` / `setup` readiness report. */
export function renderCheckReport(report) {
  const lines = [
    `DeepSeek Harness bridge readiness: ${report.ready ? "ready" : "not ready"}`,
    `${statusIcon(report.node.available)} node — ${report.node.detail}`,
    `${statusIcon(report.dsh.available)} dsh — ${report.dsh.detail}`
  ];
  if (report.npm) {
    lines.push(`${statusIcon(report.npm.ok)} npm pin — ${report.npm.detail}`);
  }
  if (report.harness) {
    lines.push(`${statusIcon(report.harness.ok)} harness checkout — ${report.harness.detail}`);
  }
  lines.push(
    `${statusIcon(report.auth.ok)} credentials — ${report.auth.detail}`,
    `${statusIcon(report.profile.ready)} cc profile — ${report.profile.detail}`,
    `${statusIcon(true)} broker — ${report.broker.detail}`
  );
  if (report.actionsTaken?.length) {
    lines.push("", "Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
  }
  if (report.nextSteps?.length) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function jobLine(job) {
  const status = job.status.padEnd(9);
  const when = (job.createdAt ?? "").replace("T", " ").slice(0, 19);
  return `${job.id}  ${status}  ${job.kindLabel ?? job.kind}  ${when}  ${job.summary ?? ""}`.trimEnd();
}

/** Render the `runs` listing. */
export function renderStatusReport(report) {
  if (report.jobs.length === 0) {
    return "No DeepSeek Harness runs recorded for this workspace.\n";
  }
  const lines = ["DeepSeek Harness runs (newest first):", ...report.jobs.map(jobLine)];
  lines.push("", "Details: /dsh:show <run-id> · Stop: /dsh:stop <run-id>");
  return `${lines.join("\n")}\n`;
}

/** Render one job's status block. */
export function renderJobStatusReport(job) {
  const lines = [
    `${job.title ?? job.kindLabel ?? job.kind} — ${job.id}`,
    `status: ${job.status}${job.phase && job.phase !== job.status ? ` (${job.phase})` : ""}`,
    `started: ${job.createdAt ?? "unknown"}`
  ];
  if (job.finishedAt) {
    lines.push(`finished: ${job.finishedAt}`);
  }
  if (job.dshSessionId) {
    lines.push(`dsh session: ${job.dshSessionId}`);
  }
  if (job.errorMessage) {
    lines.push(`error: ${job.errorMessage}`);
  }
  if (job.logFile) {
    lines.push(`log: ${job.logFile}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render a stored (finished) job result for `show`. */
export function renderStoredJobResult(job, stored) {
  const rendered = stored?.result?.rendered;
  if (rendered) {
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }
  return renderJobStatusReport(job);
}

/** Render structured review/critique output; falls back to raw text. */
export function renderReviewResult(parsed, { reviewLabel, targetLabel }) {
  if (!parsed.parsed) {
    const raw = parsed.rawOutput?.trim();
    const header = `${reviewLabel} of ${targetLabel} (unstructured output${parsed.parseError ? `: ${parsed.parseError}` : ""})`;
    return `${header}\n\n${raw || "(no output)"}\n`;
  }
  const result = parsed.parsed;
  const lines = [`${reviewLabel} of ${targetLabel}`, ""];
  if (result.summary) {
    lines.push(result.summary, "");
  }
  const findings = Array.isArray(result.findings) ? result.findings : [];
  if (findings.length === 0) {
    lines.push("No findings reported.");
  } else {
    for (const [index, finding] of findings.entries()) {
      const location = finding.file ? ` — ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
      lines.push(`${index + 1}. [${finding.severity ?? "info"}] ${finding.title ?? "finding"}${location}`);
      if (finding.body) {
        lines.push(`   ${String(finding.body).replace(/\n/g, "\n   ")}`);
      }
    }
  }
  if (result.verdict) {
    lines.push("", `Verdict: ${result.verdict}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render a plain (non-structured) review result. */
export function renderNativeReviewResult({ status, stdout, stderr }, { reviewLabel, targetLabel }) {
  if (status !== 0) {
    return `${reviewLabel} of ${targetLabel} failed.\n${(stderr || stdout || "").trim()}\n`;
  }
  return `${reviewLabel} of ${targetLabel}\n\n${(stdout || "").trim() || "(no output)"}\n`;
}

/** Render a delegate/run result. */
export function renderTaskResult({ rawOutput, failureMessage }, { title, jobId, write, dshSessionId }) {
  const lines = [];
  if (failureMessage) {
    lines.push(`${title} failed.`, failureMessage.trim());
  } else {
    lines.push(rawOutput.trim() || `${title} finished with no assistant output.`);
  }
  const footer = [];
  if (jobId) {
    footer.push(`run: ${jobId}`);
  }
  if (dshSessionId) {
    footer.push(`dsh session: ${dshSessionId} (continue with /dsh:run --resume)`);
  }
  footer.push(write ? "mode: workspace-write" : "mode: read-only");
  lines.push("", `— ${footer.join(" · ")}`);
  return `${lines.join("\n")}\n`;
}

/** Render a `stop` confirmation. */
export function renderCancelReport(job, { stale = false, brokerStopped = false } = {}) {
  const label = `${job.title ?? job.kind} ${job.id}`;
  const lines = [stale ? `Marked ${label} as cancelled; its processes were already gone.` : `Stopped ${label}.`];
  if (brokerStopped) {
    lines.push("The shared DSH broker was stopped to abort the in-flight turn; in-memory dsh sessions for this workspace are gone.");
  }
  return `${lines.join("\n")}\n`;
}

/** Render the refusal when `stop` loses the terminal-claim race. */
export function renderStopRefusedReport(job, { brokerBusy = false } = {}) {
  const lines = [`Run ${job.id} already finished; nothing to stop.`];
  if (brokerBusy) {
    lines.push("The DSH broker is still busy; /dsh:stop --broker aborts it (this discards in-memory dsh sessions).");
  }
  return `${lines.join("\n")}\n`;
}
