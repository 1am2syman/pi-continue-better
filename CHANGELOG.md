# Changelog

## 0.2.0

- **Auto-resume after compaction.** Hooks `session_compact` and sends a resume
  prompt so the agent continues the task in the same session without a manual
  "continue". Fires after manual `/compact` and threshold auto-compaction.
  Overflow is left untouched (pi already retries the aborted turn). Never
  double-resumes (guards on `willRetry`).
- Resume message is injected as a labeled `pi-continue-better-resume` custom
  message with `triggerTurn: true`, not as fake user input.
- New config key `autoResume` (default `true`) to opt out.
- `/continue-better` status now reports the `autoResume` setting.

## 0.1.0

- Initial release.
- Hooks `session_before_compact` and replaces pi's default summarizer with a
  structured 7-slot continuation handoff.
- Fuses `pi-continue`'s ledger discipline, `/handoff`'s secret redaction +
  verbatim-quote allowance, and `pi-grounded-compaction`'s files-touched tracking
  + model presets.
- Adds a configurable `toolResultBudget` (default 8000) so the summarizer sees
  more of long tool outputs than pi's stock 2000-char serialization.
- Adds a `/continue-better` status command.
- Fails open to pi's default compaction on any summarizer error.
