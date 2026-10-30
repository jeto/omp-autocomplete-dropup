/**
 * Renders the prompt autocomplete dropdown (slash commands, @files, …) above the
 * input instead of below it, so the input row stays put while the list narrows.
 *
 * Modes (plugin setting `mode`, or `/dropup overlay|inline`):
 * - overlay (default): the editor never grows; after every frame the list is
 *   written straight onto the terminal rows above the input, like Claude Code.
 *   Rows the box uncovers when the list shrinks are restored right away when
 *   they are live viewport rows. Rows already in native scrollback (which omp
 *   cannot repaint in place) stay blank until a full history replay, the same
 *   one a theme change runs: after typing pauses or only on close
 *   (`scrollbackRestore`). When there is no room above the input, the list
 *   renders below it (stock).
 * - inline: the list is inserted above the input and pushes the transcript up.
 *
 * Relies on omp internals (CI checks the latest omp release): `Editor.render()` appends
 * the dropdown rows after the editor rows, `Editor.debugChildren` exposes the
 * dropdown list, the composer's rows are the TUI's children in screen order,
 * `TUI.getMutableViewport()` reports where the live viewport sits on screen,
 * and the status line takes its bottom-bar probe via `setAutocompleteActiveProbe`.
 * When any of these is missing the dropdown renders stock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings, PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";

type Mode = "overlay" | "inline";
type ScrollbackRestore = "typing-pause" | "on-close";

interface DropUpSettings {
	mode: Mode;
	scrollbackRestore: ScrollbackRestore;
	scrollbackRestoreDelayMs: number;
}

interface SettingSchema {
	default?: unknown;
	values?: string[];
	min?: number;
	max?: number;
}

/** package.json is the single source of truth for the plugin name and setting defaults. */
const manifest: { name: string; omp: { settings: Record<keyof DropUpSettings, SettingSchema> } } = JSON.parse(
	fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"),
);
const PLUGIN_NAME = manifest.name;
const SCHEMA = manifest.omp.settings;

function pickEnum<T extends string>(key: keyof DropUpSettings, raw: unknown): T {
	const { values = [], default: fallback } = SCHEMA[key];
	return (values.includes(raw as string) ? raw : fallback) as T;
}

function pickNumber(key: keyof DropUpSettings, raw: unknown): number {
	const { min = -Infinity, max = Infinity, default: fallback } = SCHEMA[key];
	const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
	return Math.min(max, Math.max(min, Number.isFinite(value) ? value : (fallback as number)));
}

function resolveSettings(raw: Record<string, unknown>): DropUpSettings {
	return {
		mode: pickEnum<Mode>("mode", raw.mode),
		scrollbackRestore: pickEnum<ScrollbackRestore>("scrollbackRestore", raw.scrollbackRestore),
		scrollbackRestoreDelayMs: pickNumber("scrollbackRestoreDelayMs", raw.scrollbackRestoreDelayMs),
	};
}

let settings = resolveSettings({});
let settingsCwd = process.cwd();

/** Re-reads the stored plugin settings; edits made in the settings UI apply from the next popup. */
async function refreshSettings(): Promise<void> {
	try {
		settings = resolveSettings(await getPluginSettings(PLUGIN_NAME, settingsCwd));
	} catch {
		// Unreadable plugin config: keep the last known settings.
	}
}

class DropUpEditor extends CustomEditor {
	readonly #tui: TUI;
	/** Rows of the open popup box (blank separator on top, list below it); empty while closed. */
	#popup: string[] = [];
	#editorRowCount = 0;
	#rowsBelowEditor = 0;
	/** Screen row of the last painted box top, to find rows it uncovered when it shrinks. */
	#paintedTop: number | undefined;
	#coveredHistory = false;
	#paintQueued = false;
	#replayTimer: Timer | undefined;
	/**
	 * Whether this frame renders the list below the input (stock fallback). A bottom status bar
	 * yields its row to the list only then; otherwise hiding it would move the input.
	 */
	#listBelowInput = false;
	readonly #statusBarYields = (): boolean => this.#listBelowInput;

	constructor(tui: TUI, ...args: unknown[]) {
		super(...args);
		this.#tui = tui;
	}

	override render(width: number): readonly string[] {
		this.#claimStatusBarProbe();
		this.#listBelowInput = false;
		const rows = super.render(width);
		// `debugChildren` is an internal hook; an upgrade that drops it leaves the stock layout.
		const list = this.isShowingAutocomplete() ? this.debugChildren?.[0] : undefined;
		const listRows = list ? list.render(width) : [];
		const n = listRows.length;
		if (n === 0 || n >= rows.length) {
			this.#closePopup();
			return rows;
		}
		const editorRows = rows.slice(0, -n);
		if (settings.mode === "inline") {
			this.#closePopup();
			return [...listRows, ...editorRows];
		}
		const below = this.#measureRowsBelow(width);
		const vp = typeof this.#tui.getMutableViewport === "function" ? this.#tui.getMutableViewport() : undefined;
		// +1: a blank top row separates the box from the transcript above it.
		const height = n + 1;
		if (below === undefined || !vp || vp.length === 0 || vp.top + vp.length - below - editorRows.length < height) {
			// Unknown layout or no room above the input: stock layout (grows into the free rows below).
			this.#listBelowInput = true;
			this.#closePopup();
			return rows;
		}
		if (this.#popup.length === 0) void refreshSettings();
		this.#popup = ["", ...listRows];
		this.#editorRowCount = editorRows.length;
		this.#rowsBelowEditor = below;
		this.#schedule(() => this.#paint());
		return editorRows;
	}

	/**
	 * The status line hides its bottom bar while `isAutocompleteActive()` is true, to make room for
	 * the stock list below the input. Re-pointed every frame because each composer-shape sync
	 * re-attaches the status line with the default probe.
	 */
	#claimStatusBarProbe(): void {
		const facts = this.composerFacts;
		if (facts && "setAutocompleteActiveProbe" in facts && typeof facts.setAutocompleteActiveProbe === "function") {
			facts.setAutocompleteActiveProbe(this.#statusBarYields);
		}
	}

	/**
	 * Rows the composer paints below the editor (extension `belowEditor` widgets, a bottom status
	 * bar), measured by rendering the composer roots that follow the editor's own root. The
	 * composer mounts its roots as the TUI's children in screen order. `undefined` when the editor
	 * cannot be located there.
	 */
	#measureRowsBelow(width: number): number | undefined {
		const roots = this.#tui.children;
		const index = roots.findIndex(
			root => root === this || ("children" in root && Array.isArray(root.children) && root.children.includes(this)),
		);
		if (index < 0) return undefined;
		let rows = 0;
		for (let i = index + 1; i < roots.length; i++) rows += roots[i]!.render(width).length;
		return rows;
	}

	/** Runs after the frame being rendered has been written. */
	#schedule(task: () => void): void {
		if (this.#paintQueued) return;
		this.#paintQueued = true;
		queueMicrotask(() => {
			this.#paintQueued = false;
			task();
		});
	}

	#paint(): void {
		const rows = this.#popup;
		if (rows.length === 0) return;
		const vp = this.#tui.getMutableViewport();
		if (vp.length === 0) return;
		const top = vp.top + vp.length - this.#rowsBelowEditor - this.#editorRowCount - rows.length;
		if (top < 0) return;
		const prevTop = this.#paintedTop;
		const shrank = prevTop !== undefined && prevTop < top;
		let out = "\x1b[?2026h\x1b7";
		if (shrank) for (let r = prevTop; r < top; r++) out += `\x1b[${r + 1};1H\x1b[0m\x1b[2K`;
		for (let i = 0; i < rows.length; i++) out += `\x1b[${top + i + 1};1H\x1b[0m\x1b[2K${rows[i]}\x1b[0m`;
		out += "\x1b8\x1b[?2026l";
		this.#tui.terminal.write(out);
		this.#paintedTop = top;
		if (top < vp.top) this.#coveredHistory = true;
		if (!shrank) return;
		// Uncovered live rows: the TUI still believes they show its content, so force a viewport repaint.
		if (Math.max(prevTop, vp.top) < top) this.#tui.requestRender(true);
		// Uncovered scrollback rows: only a history replay restores them.
		if (prevTop < vp.top && settings.scrollbackRestore === "typing-pause") this.#scheduleReplay();
	}

	#scheduleReplay(): void {
		clearTimeout(this.#replayTimer);
		this.#replayTimer = setTimeout(() => {
			this.#replayTimer = undefined;
			if (this.#popup.length > 0) this.#tui.requestRender(true, { clearScrollback: true });
		}, settings.scrollbackRestoreDelayMs);
	}

	#closePopup(): void {
		if (this.#popup.length === 0) return;
		this.#popup = [];
		this.#paintedTop = undefined;
		clearTimeout(this.#replayTimer);
		this.#replayTimer = undefined;
		const replay = this.#coveredHistory;
		this.#coveredHistory = false;
		queueMicrotask(() => this.#tui.requestRender(true, replay ? { clearScrollback: true } : undefined));
	}
}

export default function dropUpAutocomplete(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		settingsCwd = ctx.cwd;
		await refreshSettings();
		// Another extension's editor wins; don't clobber it.
		if (ctx.ui.getEditorComponent?.()) return;
		ctx.ui.setEditorComponent((tui, theme) => new DropUpEditor(tui, theme));
	});

	pi.registerCommand("dropup", {
		description: "Autocomplete drop-up: overlay (covers transcript) or inline (pushes it up)",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim();
			let mode: Mode;
			if (arg === "overlay" || arg === "inline") mode = arg;
			else if (arg === "") mode = settings.mode === "overlay" ? "inline" : "overlay";
			else return ctx.ui.notify("Usage: /dropup [overlay|inline]", "warning");
			await new PluginManager(ctx.cwd).setPluginSetting(PLUGIN_NAME, "mode", mode);
			settings = { ...settings, mode };
			ctx.ui.notify(`Drop-up autocomplete: ${mode}`, "info");
		},
	});
}
