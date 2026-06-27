# pi-continue-better

> Same-session, **high-fidelity** compaction for [pi-coding-agent](https://pi.dev).
> `/handoff` fidelity, but it stays in your session — no `/new`, no restart.

`pi-continue-better` hooks pi's `session_before_compact` and replaces the default
summarizer with a curated **continuation handoff** that combines the best ideas
from three community packages into one:

| Source idea | What it contributes here |
|---|---|
| [`pi-continue`](https://pi.dev/packages/pi-continue) | Disciplined **7-slot ledger** (`task`, `done_when`, `established`+anchors, `learned`, `open`, `forbid`, `next`) that accumulates across compactions |
| `/handoff` skill | Explicit **secret/PII redaction** + **verbatim-quote allowance** (preserve exact paths, identifiers, commands, snippets) |
| [`pi-grounded-compaction`](https://pi.dev/packages/pi-grounded-compaction) | Deterministic **files-touched tracking** + **summarizer model presets** |
| this package | A **higher tool-result budget** than pi's stock 2000-char serialization, so the summarizer actually sees enough of long `bash`/`read` outputs to quote them verbatim — the concrete fidelity boost |

Same task, same session, no restart. It fires on `/compact`, on the auto-compaction
threshold, and on overflow recovery.

## Install

```bash
pi install git:github.com/1am2syman/pi-continue-better
```

Update later:

```bash
pi update --extension git:github.com/1am2syman/pi-continue-better
```

Try it once without installing:

```bash
pi -e git:github.com/1am2syman/pi-continue-better
```

Then just run `/compact` (or let auto-compaction fire). Run `/continue-better` to
see the active config and the last run.

> ⚠ **Mutual exclusion.** This extension owns `session_before_compact` and returns
> its own compaction result. Enable **only one** compaction-owning extension at a
> time (`pi-continue`, `pi-grounded-compaction`, `pi-agenticoding`, or this one).
> Two active at once race and the last handler wins.

## Why "better"

`/handoff` gives you a curated summary but forces a **new session**. `pi-continue`
keeps you in the **same session** but sees messages through pi's stock serializer,
which **truncates every tool result to 2000 chars** before the summarizer ever sees
it — so long `bash`/`read` outputs (often where the critical detail lives) are
already gone. `pi-continue-better` keeps you in the same session **and** raises that
budget (default 8000, configurable), then instructs the model to preserve critical
values verbatim and redact secrets. You get `/handoff`'s fidelity without leaving
the session.

## Configuration

Defaults ship in [`settings.json`](settings.json). Override per-user or per-project
(no code edits needed):

- global: `~/.pi/agent/extensions/pi-continue-better.json`
- project (wins): `<project>/.pi/extensions/pi-continue-better.json`

```jsonc
{
  "enabled": true,                 // set false to fall through to pi's default compaction
  "summarizerModel": "inherit",    // "inherit" = active session model; or "provider/modelId"
                                   //   e.g. "google/gemini-2.5-flash" for a cheap compactor
  "toolResultBudget": 8000,        // chars of each tool result fed to the summarizer (pi stock = 2000)
  "maxTokens": 8192,               // summarizer output budget
  "appendFilesTouched": true,      // cumulative files-touched manifest in the summary
  "appendReadFileTags": true,      // <read-files> block (pi-native shape)
  "appendModifiedFileTags": true,  // <modified-files> block (pi-native shape)
  "redactSecrets": true,           // instructs the model + scrubs obvious patterns after
  "notify": true                   // info/warning notifications
}
```

### Use a cheaper model for compaction only

Your session can run on Opus while compaction runs on Flash:

```jsonc
{ "summarizerModel": "google/gemini-2.5-flash" }
```

Because compaction serializes messages to text first, there is **no prefix-cache
cost** to routing the summary to a cheaper/faster model.

## The handoff shape

Every compaction produces a structured markdown handoff. The model is required to
emit these sections (full rules in [`assets/compaction-prompt.md`](assets/compaction-prompt.md)):

```
## Task            — one-sentence active goal
## Done when       — one-sentence completion criterion
## Established     — anchored facts (path:line / test:name / cmd:... / user@msg-id) + reopen conditions
## Learned         — derived insights, preferences, dead ends (with reason)
## Open            — unverified questions + what evidence would close them
## Forbid          — hard prohibitions + known-bad paths, with attribution
## Next            — ordered next actions; next[0] is the immediate resume action
```

followed by an optional cumulative files-touched manifest and `<read-files>` /
`<modified-files>` blocks.

## Failure policy

The extension **fails open**. If the summarizer model can't be resolved, auth fails,
the call errors, or the response is empty, it returns nothing and pi falls back to
its built-in compaction. No raw directive text is leaked. Aborts are honored via the
shared `signal`.

## Status command

```
/continue-better
```

Prints the resolved config, the summarizer model, the tool-result budget, and the
last run (ok/failed, reason, message count, error if any).

## What it does NOT do

- It does not patch pi or vendor code.
- It does not fork, switch, or create sessions — that's the point.
- It does not rewrite transcript history or interrupt running tools.
- It is not a memory system or a context pruner; it only customizes compaction.
- It does not auto-load past summaries into future sessions beyond the standard
  `previousSummary` pi passes to `session_before_compact`.

## Files

```
pi-continue-better/
├── package.json                # npm metadata + pi manifest
├── settings.json               # package-local defaults
├── tsconfig.json               # typecheck config (no build needed; pi loads .ts)
├── extensions/
│   └── index.ts                # the extension (hooks session_before_compact)
├── assets/
│   └── compaction-prompt.md    # the 7-slot handoff prompt (redaction + verbatim)
└── examples/
    └── settings-compaction-75pct.json
```

## License

MIT © 1am2syman
