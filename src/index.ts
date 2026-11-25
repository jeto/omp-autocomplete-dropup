/**
 * Renders the prompt autocomplete dropdown (slash commands, @files, …) above the
 * input instead of below it, so the input row stays put while the list narrows.
 *
 * Modes (plugin setting `mode`, or `/dropup overlay|inline`):
 * - overlay (default): the list takes no room in the layout. Each frame, just
 *   before omp writes it, the list rows replace the viewport rows above the
 *   input, like Claude Code. omp's own frame diff then repaints the transcript
 *   rows when the list shrinks or closes. When fewer rows than the list fit
 *   above the input, it shows a window around the selected item; with under
 *   three rows of room, the list renders below the input (stock).
 * - inline: the list is drawn above the input and pushes the transcript up.
 * Either way the bottom status bar keeps its row while the list is open.
 *
 * Relies on omp internals (CI checks the latest omp release): the composer is
 * painted by the `col` `omp.editor` role painter with the list as trailing
 * `covering` rows, the status panel (`col` `omp.status.panel`) drops its bar
 * while `term.placement.autocomplete` is set, and `FrameWriter.present` receives
 * every inline frame with the caret in viewport coordinates. When a painter is
 * missing the dropdown renders stock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings, PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { FramePlan } from "@oh-my-pi/pi-tui/driver/contract";
import { FrameWriter } from "@oh-my-pi/pi-tui/driver/output/writer";
import { type Block, defineRolePainter, type Painter, painterFor } from "@oh-my-pi/pi-tui/term/paint";

type Mode = "overlay" | "inline";

interface DropUpSettings {
	mode: Mode;
}

interface SettingSchema {
	default?: unknown;
	values?: string[];
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

let settings: DropUpSettings = { mode: pickEnum<Mode>("mode", undefined) };
let settingsCwd = process.cwd();

/** Re-reads the stored plugin settings; edits made in the settings UI apply from the next popup. */
async function refreshSettings(): Promise<void> {
	try {
		const raw = await getPluginSettings(PLUGIN_NAME, settingsCwd);
		settings = { mode: pickEnum<Mode>("mode", raw.mode) };
	} catch {
		// Unreadable plugin config: keep the last known settings.
	}
}

/**
 * How the open list is laid out: `overlay` draws it into the frame above the input, `inline`
 * inside the layout above the input, `stock` below it (too little room above), `closed` none.
 */
type Layout = "closed" | "overlay" | "inline" | "stock";

let layout: Layout = "closed";
/** The overlay's list rows, top first, waiting to be drawn into the next frame. */
let overlayRows: readonly string[] = [];
/** The caret's row inside the composer block (list rows excluded), from the last composer paint. */
let caretRow: number | undefined;
/**
 * Viewport row of the composer's top, measured on frames where the list does not move it
 * (every layout but `stock`).
 */
let composerTop: number | undefined;

/** One blank row between the transcript and the list. */
const SEPARATOR = 1;
/** Fewer list rows than this fit above the input: render the list stock instead. */
const MIN_ROWS = 3;

/**
 * The `room` rows of `rows` to show, as `[start, end)`: a window around the selected item, the
 * only row that starts at the first cell (the others are indented by the selection marker).
 */
function clip(rows: readonly string[], room: number): [number, number] {
	if (rows.length <= room) return [0, rows.length];
	const selected = Math.max(0, rows.findIndex(row => !/^\s/.test(Bun.stripANSI(row))));
	const start = Math.min(Math.max(0, selected - Math.floor((room - 1) / 2)), rows.length - room);
	return [start, start + room];
}

/** Moves the `covering` list rows of a composer block from below the input to above it. */
function listAbove(block: Block, list: number): Block {
	const own = block.rows.length - list;
	return {
		...block,
		rows: [...block.rows.slice(own), ...block.rows.slice(0, own)],
		...(block.cursor ? { cursor: { row: block.cursor.row + list, col: block.cursor.col } } : {}),
		...(block.hits ? { hits: block.hits.map(h => ({ ...h, row: h.row >= own ? h.row - own : h.row + list })) } : {}),
	};
}

/**
 * The composer block without its list rows. Click targets of the shown list rows `[start, end)`
 * move to where the overlay draws them, directly above the composer.
 */
function withoutList(block: Block, list: number, start: number, end: number): Block {
	const own = block.rows.length - list;
	const { covering: _covering, ...rest } = block;
	const hits = block.hits
		?.filter(h => h.row < own || (h.row >= own + start && h.row < own + end))
		.map(h => (h.row >= own ? { ...h, row: h.row - own - end } : h));
	return { ...rest, rows: block.rows.slice(0, own), ...(hits ? { hits } : {}) };
}

function wrapComposer(original: Painter): Painter {
	return (node, cx) => {
		const block = original(node, cx);
		// Previews (settings, gallery) have no caret: only the live composer drives the state.
		if (!block.cursor) return block;
		const list = block.covering ?? 0;
		if (list === 0 || list >= block.rows.length) {
			layout = "closed";
			caretRow = block.cursor.row;
			return block;
		}
		if (layout === "closed") void refreshSettings();
		caretRow = block.cursor.row;
		if (settings.mode === "inline") {
			layout = "inline";
			return listAbove(block, list);
		}
		const room = (composerTop ?? 0) - SEPARATOR;
		if (room < Math.min(list, MIN_ROWS)) {
			layout = "stock";
			return block;
		}
		const rows = block.rows.slice(block.rows.length - list);
		const [start, end] = clip(rows, room);
		layout = "overlay";
		overlayRows = rows.slice(start, end);
		return withoutList(block, list, start, end);
	};
}

/** Keeps the bottom status bar in place while the list is open, so the input does not drop into its row. */
function wrapStatusPanel(original: Painter): Painter {
	return (node, cx) => {
		const term = (node.props() as { term?: { placement?: { autocomplete?: boolean } } }).term;
		// Stock layout: the list sits where the bar was, as without the plugin.
		if (!term?.placement?.autocomplete || layout === "stock") return original(node, cx);
		const props = { ...node.props(), term: { ...term, placement: { ...term.placement, autocomplete: false } } };
		const shown = new Proxy(node, {
			get(target, key) {
				if (key === "props") return () => props;
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return original(shown, cx);
	};
}

function drawList(frame: FramePlan): FramePlan {
	if (frame.fullscreen || !frame.cursor || caretRow === undefined) return frame;
	const top = frame.cursor.row - caretRow;
	if (layout !== "stock") composerTop = top;
	if (layout !== "overlay") return frame;
	// The composer moved since its paint (content changed above it): keep what still fits.
	const [start, end] = clip(overlayRows, top - SEPARATOR);
	const rows = ["", ...overlayRows.slice(start, end)];
	const first = top - rows.length;
	if (first < 0 || rows.length <= SEPARATOR) return frame;
	const viewport = [...frame.viewport];
	for (let i = 0; i < rows.length; i++) viewport[first + i] = rows[i]!;
	return { ...frame, viewport };
}

const WRAPPED = Symbol.for("omp-autocomplete-dropup.wrapped");
type Marked<T> = T & { [WRAPPED]?: true };

function stub(kind: string, role: string): UiNode {
	return { kind, props: () => ({ role }) } as unknown as UiNode;
}

/** Wraps the painter registered for `kind`/`role`; false when omp no longer has one. */
function wrapPainter(kind: "col", role: string, wrap: (original: Painter) => Painter): boolean {
	const original = painterFor(stub(kind, role)) as Marked<Painter> | undefined;
	if (!original) return false;
	if (original[WRAPPED]) return true;
	const wrapped: Marked<Painter> = wrap(original);
	wrapped[WRAPPED] = true;
	defineRolePainter(kind, role, wrapped);
	return true;
}

function install(): void {
	if (!wrapPainter("col", "omp.editor", wrapComposer)) return;
	wrapPainter("col", "omp.status.panel", wrapStatusPanel);
	const proto = FrameWriter.prototype as Marked<FrameWriter>;
	if (proto[WRAPPED]) return;
	const present = proto.present;
	proto.present = function (this: FrameWriter, frame: FramePlan) {
		return present.call(this, drawList(frame));
	};
	proto[WRAPPED] = true;
}

export default function dropUpAutocomplete(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		settingsCwd = ctx.cwd;
		await refreshSettings();
		if (ctx.hasUI) install();
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
