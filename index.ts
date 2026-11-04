import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import {
	effectiveRunState,
	inboxDir,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	type InboxMessage,
	type RunMetadata,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	let pickerSession = {};
	let refreshPicker: ((runs?: RunMetadata[]) => void) | undefined;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			let runs = listRuns(sessionId)
				.map((run) => ({ ...run, state: effectiveRunState(run) }))
				.filter((run) => run.state !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			refreshPicker?.();
			const picker = (pickerSession = {});
			const isCurrent = () => pickerSession === picker && ctx.sessionManager.getSessionId() === sessionId;
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				let active = true;
				const dispose = () => {
					active = false;
					if (refreshPicker === refresh) refreshPicker = undefined;
				};
				const finish = (value?: string) => {
					if (!active) return;
					dispose();
					done(value);
				};
				const listTheme = {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				};
				let items: SelectItem[] = [];
				let list: SelectList;
				const listContainer = new Container();
				const refresh = (nextRuns?: RunMetadata[]) => {
					if (!active) return;
					if (!nextRuns || !isCurrent()) {
						finish();
						return;
					}
					runs = nextRuns;
					const nextItems: SelectItem[] = runs.map((run) => ({
						value: run.handle,
						label: `${runDisplayName(run)}  ${run.state.padEnd(8)}  ${run.provider}/${run.model}  ${run.thinking}`,
					}));
					if (
						items.length === nextItems.length &&
						items.every((item, i) => item.value === nextItems[i].value && item.label === nextItems[i].label)
					) return;
					const handle = list?.getSelectedItem()?.value;
					const index = Math.max(0, items.findIndex((item) => item.value === handle));
					const hadList = !!list;
					items = nextItems;
					list = new SelectList(items, Math.min(items.length, 10), listTheme);
					const retainedIndex = items.findIndex((item) => item.value === handle);
					list.setSelectedIndex(retainedIndex < 0 ? Math.min(index, items.length - 1) : retainedIndex);
					list.onSelect = (item) => finish(item.value);
					list.onCancel = () => finish();
					listContainer.clear();
					listContainer.addChild(items.length ? list :
						new Text(theme.fg("warning", "No active subagents spawned by this session"), 2, 0));
					if (hadList) customTui.requestRender();
				};
				refresh(runs);
				if (active) refreshPicker = refresh;

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
				container.addChild(listContainer);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						if (!active) return;
						if (!isCurrent()) {
							finish();
							return;
						}
						list.handleInput(data);
						if (active) customTui.requestRender();
					},
					dispose,
				};
			});
			if (!selected || !tui || !isCurrent()) return;
			const candidate = runs.find((run) => run.handle === selected);
			const run = candidate && readMetadata(candidate.runDir);
			if (
				!run || run.handle !== selected || run.parentSessionId !== sessionId || run.suspended ||
				run.state === "exited" || !tmuxSessionExists(run.tmuxSession)
			) return;

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			refreshPicker?.(activeRuns.map(({ run, state }) => ({ ...run, state })));
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			pickerSession = {};
			refreshPicker?.();
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || tmuxSessionExists(run.tmuxSession)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			pickerSession = {};
			refreshPicker?.();
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!tmuxSessionExists(run.tmuxSession)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
				await waitForRunShutdown(run.runDir);
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
			...(ctx.thinkingLevel !== undefined ? { thinking: ctx.thinkingLevel } : {}),
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("model_select", (event, ctx) => {
		const model = ctx.model ?? event.model;
		updateMetadata(runDir, {
			provider: model.provider,
			model: model.id,
			// Model switches can change effective thinking without a thinking-level event.
			...(ctx.thinkingLevel !== undefined ? { thinking: ctx.thinkingLevel } : {}),
		});
	});

	pi.on("thinking_level_select", (event, ctx) => {
		// Pi does not await these events, so the payload may already be stale.
		updateMetadata(runDir, { thinking: ctx.thinkingLevel ?? event.level });
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
