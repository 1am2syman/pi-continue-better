# Changelog

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
