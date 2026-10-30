import { execFile, spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	tmuxSession: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	/** Set when the parent runs inside Rex; the child then shows itself in a Rex block while working. */
	rex?: RexAnchor;
	viewerBlock?: string;
	viewerOpenedAt?: string;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

/** The Rex block the parent Pi runs in, used to place the subagent viewer beside it. */
export interface RexAnchor {
	bin: string;
	server?: string;
	block: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.tmuxSession !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function tmuxSessionExists(session: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

/** Start the child pi process for a run in its tmux session. `initialArgs` are only passed on first spawn. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	// Local patch: children run as Bkper Agent (`bkper agent` passthrough) instead of plain pi.
	let launcher = ["bkper", "agent"];
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = [testLauncher];
	} catch {
		// Use the installed bkper executable.
	}

	const result = spawnSync(
		"tmux",
		[
			"new-session",
			"-d",
			"-s",
			metadata.tmuxSession,
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			metadata.cwd,
			"--",
			"env",
			`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
			...launcher,
			// Local patch: the parent already trusts this project; a hidden trust prompt would block the child.
			"--approve",
			"--session",
			metadata.sessionFile,
			"--provider",
			metadata.provider,
			"--model",
			metadata.model,
			"--thinking",
			metadata.thinking,
			...(metadata.launchArgs ?? []),
			...initialArgs,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
}

/** The Rex block this process runs in, or undefined outside Rex. */
export function currentRexAnchor(): RexAnchor | undefined {
	const block = process.env.REX_BLOCK;
	if (!block) return undefined;
	const binDir = process.env.REX_BIN_DIR;
	return { bin: binDir ? join(binDir, "rex") : "rex", server: process.env.REX_SERVER || undefined, block };
}

const VIEWER_LOCK_STALE_MS = 30000;

function runRex(anchor: RexAnchor, args: string[]): Promise<string | undefined> {
	const serverArgs = anchor.server ? ["-S", anchor.server] : [];
	return new Promise((resolveRun) => {
		execFile(anchor.bin, [...serverArgs, ...args], { encoding: "utf8", timeout: 15000 }, (error, stdout) =>
			resolveRun(error ? undefined : stdout),
		);
	});
}

async function rexBlockExists(anchor: RexAnchor, block: string): Promise<boolean> {
	return (await runRex(anchor, ["block", "inspect", block])) !== undefined;
}

function parseSplitBlock(output: string): string | undefined {
	try {
		const value: unknown = JSON.parse(output);
		if (typeof value !== "object" || value === null) return undefined;
		const blockIds = (value as Record<string, unknown>).block_ids;
		return Array.isArray(blockIds) && typeof blockIds[0] === "string" ? blockIds[0] : undefined;
	} catch {
		return undefined;
	}
}

interface LayoutLeaf {
	blockId: string;
	area: number;
}

function collectLeaves(node: unknown, leaves: LayoutLeaf[]): void {
	if (typeof node !== "object" || node === null) return;
	const record = node as Record<string, unknown>;
	const rect = record.rect;
	if (typeof record.block_id === "string" && Array.isArray(rect) && rect.length === 4) {
		const [, , width, height] = rect;
		if (typeof width === "number" && typeof height === "number") {
			leaves.push({ blockId: record.block_id, area: width * height });
		}
		return;
	}
	const split = record.split;
	if (typeof split === "object" && split !== null) {
		const parts = split as Record<string, unknown>;
		collectLeaves(parts.before, leaves);
		collectLeaves(parts.after, leaves);
	}
}

/** The largest other tiled block in the parent's Rex window, or undefined when the parent is alone. */
async function largestOtherBlock(rex: RexAnchor): Promise<string | undefined> {
	const info = await runRex(rex, ["block", "inspect", rex.block]);
	const sessionId = info?.match(/^session: (\S+)$/m)?.[1];
	const windowId = info?.match(/^window: (\S+)$/m)?.[1];
	if (!sessionId || !windowId) return undefined;
	const output = await runRex(rex, ["api", "call", "session.view", JSON.stringify({ session_id: sessionId })]);
	if (!output) return undefined;
	let view: unknown;
	try {
		view = JSON.parse(output);
	} catch {
		return undefined;
	}
	const windows = (view as { windows?: unknown } | null)?.windows;
	if (!Array.isArray(windows)) return undefined;
	const window: unknown = windows.find(
		(candidate: unknown) => (candidate as { window_id?: unknown } | null)?.window_id === windowId,
	);
	const layers = (window as { layers?: unknown } | undefined)?.layers;
	if (!Array.isArray(layers)) return undefined;
	for (const layer of layers) {
		const { kind, layout } = (layer ?? {}) as { kind?: unknown; layout?: unknown };
		if (kind !== "tiled") continue;
		const leaves: LayoutLeaf[] = [];
		collectLeaves(layout, leaves);
		if (!leaves.some((leaf) => leaf.blockId === rex.block)) continue;
		return leaves
			.filter((leaf) => leaf.blockId !== rex.block)
			.sort((a, b) => b.area - a.area)[0]?.blockId;
	}
	return undefined;
}

/**
 * Open a Rex block attached to the run's tmux session unless one is already open. The first viewer stacks below
 * the largest other block in the parent's window, or goes right of a parent that is alone; later ones stack below
 * the newest open sibling viewer. Does nothing outside Rex or on failure.
 * The block closes by itself when the tmux session ends.
 */
export async function ensureRexViewer(runDir: string): Promise<void> {
	// Serialize across children so parallel spawns stack instead of all splitting beside the parent.
	const lock = join(getRunsDir(), ".rex-viewer.lock");
	const deadline = Date.now() + VIEWER_LOCK_STALE_MS;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			try {
				if (Date.now() - statSync(lock).mtimeMs > VIEWER_LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
			} catch {
				// The holder released the lock meanwhile.
			}
			if (Date.now() > deadline) return;
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
		}
	}
	try {
		await openRexViewer(runDir);
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

async function openRexViewer(runDir: string): Promise<void> {
	const metadata = readMetadata(runDir);
	const rex = metadata?.rex;
	if (!metadata || !rex) return;
	if (metadata.viewerBlock && (await rexBlockExists(rex, metadata.viewerBlock))) return;

	const neighbor = await largestOtherBlock(rex);
	let anchor = neighbor ?? rex.block;
	let direction = neighbor ? "below" : "right";
	const siblings = metadata.parentSessionId
		? listRuns(metadata.parentSessionId)
				.filter((run) => run.handle !== metadata.handle && run.viewerBlock && run.viewerOpenedAt)
				.sort((a, b) => (b.viewerOpenedAt ?? "").localeCompare(a.viewerOpenedAt ?? ""))
		: [];
	for (const sibling of siblings) {
		if (sibling.viewerBlock && (await rexBlockExists(rex, sibling.viewerBlock))) {
			anchor = sibling.viewerBlock;
			direction = "below";
			break;
		}
	}

	const output = await runRex(rex, [
		"split",
		"-b",
		anchor,
		"--split",
		direction,
		"--focus=false",
		"--label",
		metadata.name ?? metadata.handle,
		"--json",
		"--",
		"tmux",
		"attach-session",
		"-t",
		metadata.tmuxSession,
	]);
	const viewerBlock = output ? parseSplitBlock(output) : undefined;
	if (viewerBlock) updateMetadata(runDir, { viewerBlock, viewerOpenedAt: new Date().toISOString() });
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!tmuxSessionExists(metadata.tmuxSession)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
