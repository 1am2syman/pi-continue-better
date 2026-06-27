/**
 * pi-continue-better
 *
 * Same-session, high-fidelity compaction for pi-coding-agent.
 *
 * It hooks `session_before_compact` and replaces pi's default summarizer with a
 * structured "continuation handoff" that combines:
 *
 *   1. pi-continue's disciplined 7-slot ledger
 *      (task, done_when, established[+anchors], learned, open, forbid, next)
 *   2. /handoff's explicit secret/PII redaction
 *   3. /handoff's verbatim-quote allowance (preserve exact values, paths, commands, snippets)
 *   4. grounded-compaction's deterministic files-touched tracking + model presets
 *   5. A higher tool-result budget than pi's stock 2000-char serialization, so the
 *      summarizer actually sees enough of long bash/read outputs to quote them
 *      verbatim. This is the concrete fidelity boost over both /handoff (manual,
 *      new session) and pi-continue (stock serialization).
 *
 * Same session, same task, no restart — exactly what /compact does, but with a
 * curated, evidence-anchored summary.
 *
 * Install:
 *   pi install git:github.com/1am2syman/pi-continue-better
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageConfig {
	enabled: boolean;
	/** "inherit" uses the active session model; otherwise "provider/modelId". */
	summarizerModel: string;
	/** Max chars of each tool result fed to the summarizer. Pi's stock is 2000. */
	toolResultBudget: number;
	/** Max output tokens for the summarizer response. */
	maxTokens: number;
	/** Append a cumulative files-touched manifest to the persisted summary. */
	appendFilesTouched: boolean;
	/** Append <read-files> / <modified-files> blocks (pi-native compaction shape). */
	appendReadFileTags: boolean;
	appendModifiedFileTags: boolean;
	/** Instruct the summarizer to redact secrets, and scrub obvious patterns after. */
	redactSecrets: boolean;
	/** Show info/warning notifications. */
	notify: boolean;
}

interface FileOps {
	readFiles: string[];
	modifiedFiles: string[];
}

const DEFAULT_CONFIG: PackageConfig = {
	enabled: true,
	summarizerModel: "inherit",
	toolResultBudget: 8000,
	maxTokens: 8192,
	appendFilesTouched: true,
	appendReadFileTags: true,
	appendModifiedFileTags: true,
	redactSecrets: true,
	notify: true,
};

const PACKAGE_NAME = "pi-continue-better";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Try to read JSON config without throwing. Layers: defaults < global < project. */
function loadConfig(cwd: string): PackageConfig {
	const paths = [
		// global
		join(process.env.HOME || "~", ".pi/agent/extensions", `${PACKAGE_NAME}.json`),
		// project
		join(cwd, ".pi/extensions", `${PACKAGE_NAME}.json`),
	];
	let cfg: PackageConfig = { ...DEFAULT_CONFIG };
	for (const p of paths) {
		try {
			const raw = readFileSync(p, "utf8");
			const parsed = JSON.parse(raw) as Partial<PackageConfig>;
			cfg = { ...cfg, ...parsed };
		} catch {
			// missing or malformed — ignore and continue
		}
	}
	return cfg;
}

/** Resolve the summarizer model from "inherit" or "provider/modelId". */
function resolveModel(ctx: ExtensionContext, spec: string): Model<any> | undefined {
	if (!spec || spec === "inherit") return ctx.model;
	const slash = spec.indexOf("/");
	if (slash <= 0) return ctx.model;
	const provider = spec.slice(0, slash);
	const modelId = spec.slice(slash + 1);
	return ctx.modelRegistry.find(provider, modelId);
}

/**
 * Serialize messages to readable text with a configurable per-tool-result budget.
 * Mirrors pi's serializeConversation format but allows far more of long tool
 * outputs (bash/read) to survive so the summarizer can quote them verbatim.
 */
function serializeConversationRich(messages: ReturnType<typeof convertToLlm>, toolResultBudget: number): string {
	const lines: string[] = [];

	const truncate = (text: string, budget: number): string => {
		if (text.length <= budget) return text;
		const cut = budget - 60;
		const remaining = text.length - budget;
		return `${text.slice(0, Math.max(0, cut))}\n…[truncated ${remaining} chars by ${PACKAGE_NAME}]…`;
	};

	const textOf = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part: any) => {
				if (!part || typeof part !== "object") return "";
				if (part.type === "text") return typeof part.text === "string" ? part.text : "";
				if (part.type === "toolCall") {
					const name = part.name ?? "tool";
					const args = part.arguments ?? part.input ?? {};
					const argStr = Object.entries(args)
						.map(([k, v]) => {
							const vs = typeof v === "string" ? v : JSON.stringify(v);
							return `${k}=${truncate(vs, 400)}`;
						})
						.join(", ");
					return `${name}(${argStr})`;
				}
				if (part.type === "image") return "[image]";
				if (part.type === "thinking") {
					return typeof part.thinking === "string" ? part.thinking : "";
				}
				return "";
			})
			.join("\n");
	};

	for (const msg of messages) {
		const role = (msg as any).role;
		if (role === "user") {
			lines.push(`[User]: ${textOf((msg as any).content)}`);
		} else if (role === "assistant") {
			const body = textOf((msg as any).content);
			// Split thinking from the rest so the summarizer sees structure.
			lines.push(`[Assistant]: ${body}`);
		} else if (role === "toolResult" || role === "tool") {
			const tn = (msg as any).toolName ?? "tool";
			const body = textOf((msg as any).content);
			lines.push(`[Tool result (${tn})]: ${truncate(body, toolResultBudget)}`);
		} else if (role === "system") {
			// skip system prompt — not useful to summarize
		} else {
			lines.push(`[${role}]: ${textOf((msg as any).content)}`);
		}
	}
	return lines.join("\n");
}

/** Extract read/modified file paths from tool calls in raw agent messages. */
function extractFileOps(
	messagesToSummarize: any[],
	turnPrefixMessages: any[],
): FileOps {
	const read = new Set<string>();
	const modified = new Set<string>();

	const addRead = (p?: unknown) => {
		if (typeof p === "string" && p.trim()) read.add(p.trim());
	};
	const addMod = (p?: unknown) => {
		if (typeof p === "string" && p.trim()) modified.add(p.trim());
	};

	const scan = (msgs: any[]) => {
		for (const m of msgs) {
			const content = (m && (m as any).content) as any[] | undefined;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (!part || part.type !== "toolCall") continue;
				const name: string = part.name ?? "";
				const args: Record<string, unknown> = part.arguments ?? part.input ?? {};
				if (name === "read") {
					addRead(args.path);
				} else if (name === "edit" || name === "write") {
					addMod(args.path);
					if (name === "edit" && typeof args.path === "string") read.add(args.path as string);
				} else if (name === "bash") {
					scanBash(typeof args.command === "string" ? args.command : "", addRead, addMod);
				}
			}
		}
	};

	scan(messagesToSummarize);
	scan(turnPrefixMessages);

	return { readFiles: [...read], modifiedFiles: [...modified] };
}

/** Lightweight detection of file reads/writes from common shell commands. */
function scanBash(command: string, addRead: (p?: unknown) => void, addMod: (p?: unknown) => void): void {
	// Strip heredocs / comments crudely.
	const cmd = command.replace(/#.*/g, "");
	const tokens = cmd.split(/\s+/);

	// redirections: > file, >> file
	for (let i = 0; i < tokens.length - 1; i++) {
		const t = tokens[i];
		if (t === ">" || t === ">>") addMod(tokens[i + 1].replace(/^["']|["']$/g, ""));
	}
	// simple commands
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const next = tokens[i + 1];
		if (!next) continue;
		const clean = next.replace(/^["']|["']$/g, "");
		if (t === "cat" || t === "less" || t === "head" || t === "tail") addRead(clean);
		else if (t === "sed" && cmd.includes(" -i")) addMod(clean);
		else if (t === "mv" || t === "cp" || t === "touch" || t === "mkdir") {
			addMod(clean);
			if (t === "cp" && tokens[i + 2]) addMod(tokens[i + 2].replace(/^["']|["']$/g, ""));
		} else if (t === "rm") {
			addMod(clean);
		}
	}
}

/** Scrub obvious high-entropy secret patterns from the final summary. */
function scrubSecrets(text: string): string {
	if (!text) return text;
	return text
		// Bearer / api keys in quoted strings
		.replace(/(api[_-]?key|token|secret|password|bearer|authorization)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/gi, "$1: [REDACTED]")
		// Generic long hex/base64-like secrets assigned to vars
		.replace(/\b([A-Z0-9]{20,})\b(?=\b)/g, (m) => (m.length >= 32 ? "[REDACTED]" : m))
		// AWS keys
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
		// GitHub tokens
		.replace(/\bgh[opsu]_[A-Za-z0-9]{36,}\b/g, "[REDACTED]")
		// private key headers
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

/** Build the cumulative files-touched manifest block. */
function filesTouchedBlock({ readFiles, modifiedFiles }: FileOps): string {
	if (!readFiles.length && !modifiedFiles.length) return "";
	const rows: string[] = [];
	const mod = new Set(modifiedFiles);
	const all = new Set<string>([...readFiles, ...modifiedFiles]);
	for (const f of [...all].sort()) {
		const r = readFiles.includes(f) ? "R" : " ";
		const w = mod.has(f) ? "W" : " ";
		rows.push(`${r}${w} ${f}`);
	}
	return [
		"---",
		"",
		"## Files touched (cumulative)",
		"R=read, W=write/edit/move/delete",
		"",
		"```text",
		...rows,
		"```",
	].join("\n");
}

function readFilesBlock(files: string[]): string {
	if (!files.length) return "";
	return `<read-files>\n${[...new Set(files)].sort().join("\n")}\n</read-files>`;
}

function modifiedFilesBlock(files: string[]): string {
	if (!files.length) return "";
	return `<modified-files>\n${[...new Set(files)].sort().join("\n")}\n</modified-files>`;
}

/** Load the default prompt asset bundled with the package. */
function loadDefaultPrompt(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return readFileSync(join(here, "..", "assets", "compaction-prompt.md"), "utf8");
	} catch {
		return FALLBACK_PROMPT;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Reload-aware cached prompt asset + last-run telemetry.
	let cachedPrompt: string | null = null;
	let lastRun: { reason: string; model: string; messages: number; ok: boolean; error?: string } | null = null;

	const getPrompt = () => (cachedPrompt ??= loadDefaultPrompt());

	pi.on("session_before_compact", async (event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		if (!cfg.enabled) return; // fall through to pi's default compaction

		const { preparation, reason, signal, customInstructions } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } =
			preparation;

		// Nothing to summarize -> let pi handle it.
		const allRaw = [...messagesToSummarize, ...turnPrefixMessages];
		if (allRaw.length === 0) return;

		const model = resolveModel(ctx, cfg.summarizerModel);
		if (!model) {
			if (cfg.notify && !signal.aborted) {
				ctx.ui.notify(`${PACKAGE_NAME}: no model resolved; using default compaction`, "warning");
			}
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			if (cfg.notify && !signal.aborted) {
				ctx.ui.notify(`${PACKAGE_NAME}: auth failed for ${model.id}; using default compaction`, "warning");
			}
			return;
		}

		if (cfg.notify && ctx.hasUI && !signal.aborted) {
			ctx.ui.notify(
				`${PACKAGE_NAME}: summarizing ${allRaw.length} messages (~${tokensBefore.toLocaleString()} tok) with ${model.id}`,
				"info",
			);
		}

		// Higher-fidelity serialization (configurable tool-result budget).
		const conversationText = serializeConversationRich(convertToLlm(allRaw), cfg.toolResultBudget);
		const prev = previousSummary
			? `\n\nPrevious continuation handoff (treat its established/learned as cumulative; retire only with explicit reason):\n${previousSummary}`
			: "";

		const focus = customInstructions?.trim()
			? `\n\nAdditional operator focus for this compaction:\n${customInstructions.trim()}`
			: "";

		const systemPrompt = getPrompt();

		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `${systemPrompt}${prev}${focus}

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await complete(
				model,
				{ messages: summaryMessages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: cfg.maxTokens,
					signal,
				},
			);

			let summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) {
				lastRun = { reason, model: model.id, messages: allRaw.length, ok: false, error: "empty summary" };
				if (!signal.aborted && cfg.notify) {
					ctx.ui.notify(`${PACKAGE_NAME}: summary was empty; using default compaction`, "warning");
				}
				return; // fall back to default
			}

			// Files-touched grounding + native tag blocks.
			const ops = extractFileOps(messagesToSummarize as any[], turnPrefixMessages as any[]);
			if (cfg.redactSecrets) summary = scrubSecrets(summary);

			const tail: string[] = [];
			if (cfg.appendFilesTouched) {
				const block = filesTouchedBlock(ops);
				if (block) tail.push(block);
			}
			if (cfg.appendModifiedFileTags) {
				const b = modifiedFilesBlock(ops.modifiedFiles);
				if (b) tail.push(b);
			}
			if (cfg.appendReadFileTags) {
				const b = readFilesBlock(ops.readFiles);
				if (b) tail.push(b);
			}
			if (tail.length) summary = `${summary}\n\n${tail.join("\n\n")}`;

			lastRun = { reason, model: model.id, messages: allRaw.length, ok: true };

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: {
						readFiles: ops.readFiles,
						modifiedFiles: ops.modifiedFiles,
						summarizerModel: model.id,
						toolResultBudget: cfg.toolResultBudget,
						preset: cfg.summarizerModel,
					},
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastRun = { reason, model: model.id, messages: allRaw.length, ok: false, error: message };
			if (!signal.aborted && cfg.notify) {
				ctx.ui.notify(`${PACKAGE_NAME}: summarizer failed (${message}); using default compaction`, "error");
			}
			return; // fall back to pi's default compaction on any failure
		}
	});

	// Lightweight status command.
	pi.registerCommand("continue-better", {
		description: "pi-continue-better: show config + last compaction run",
		async handler(_args, ctx) {
			const cfg = loadConfig(ctx.cwd);
			const lines: string[] = [];
			lines.push(`pi-continue-better — ${cfg.enabled ? "enabled" : "disabled"}`);
			lines.push(`  summarizerModel : ${cfg.summarizerModel}`);
			lines.push(`  toolResultBudget: ${cfg.toolResultBudget} chars (pi stock = 2000)`);
			lines.push(`  maxTokens       : ${cfg.maxTokens}`);
			lines.push(`  redactSecrets   : ${cfg.redactSecrets}`);
			lines.push(`  filesTouched    : ${cfg.appendFilesTouched} | readTags=${cfg.appendReadFileTags} modTags=${cfg.appendModifiedFileTags}`);
			lines.push("");
			if (lastRun) {
				lines.push(
					`last run: ${lastRun.ok ? "ok" : "FAILED"} | reason=${lastRun.reason} | model=${lastRun.model} | messages=${lastRun.messages}` +
						(lastRun.error ? ` | error=${lastRun.error}` : ""),
				);
			} else {
				lines.push("last run: (none yet this session)");
			}
			lines.push("");
			lines.push("Config files:");
			lines.push(`  ~/.pi/agent/extensions/${PACKAGE_NAME}.json   (global)`);
			lines.push(`  <project>/.pi/extensions/${PACKAGE_NAME}.json (project, wins)`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Fallback prompt if the bundled asset can't be read.
// ---------------------------------------------------------------------------

const FALLBACK_PROMPT = `You are a continuation-handoff summarizer for a coding agent. Produce a tight, evidence-anchored handoff that lets the same agent continue this task after context compaction.

Use this exact markdown structure:

## Task
One sentence: the active goal.

## Done when
One sentence: the completion criterion.

## Established
Anchored facts that are proven true. Each MUST carry an evidence anchor like path:line, test:name, cmd:..., doc:url, or user@msg. Add a reopen condition in parentheses. The receiver treats these as proven and will not re-derive them unless the reopen condition triggers.

## Learned
Derived insights, confirmed preferences, dead ends (with reason), reusable approaches.

## Open
Unverified questions, each paired with what evidence would close them.

## Forbid
Hard prohibitions and known-bad paths, with source attribution.

## Next
Ordered next actions, each paired with the outcome it should produce. next[0] is the immediate resume action.

Rules:
- REDACT secrets: never write API keys, tokens, passwords, connection strings, or PII. Write [REDACTED] instead.
- PRESERVE VERBATIM critical values: exact file paths, identifiers, error strings, commands, and short code/snippets that the receiver must reuse unchanged. Quote them in backticks rather than paraphrasing.
- Carry forward Established and Learned from the previous handoff unless explicitly retired; never silently drop them.
- Be concise. Omit pleasantries. Every line must help continuation.`;
