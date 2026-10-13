import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { Mermaid, MermaidConfig } from 'mermaid';
import { boxAt, boxOfZoomButton, decorate, undecorate } from './actions';
import { registerCliCommands } from './cli';
import { DiagramEditor } from './editor';
import { FlowchartEditor, flowchartRender } from './flowchart-editor';
import { SourceRegistry, isElement, wrapRender } from './render';
import { WardleyEditor } from './wardley-editor';
import { wardleyCliSpecs } from './wardley-cli';
import { wardleyRender } from './wardley-render';
import { DiagramZoom, ZOOM_ID_PREFIX } from './zoom';

declare const __MERMAID_VERSION__: string;
declare const require: (id: string) => any;

/** Bundled Mermaid release, injected by esbuild from the installed package. */
export const PINNED_VERSION = __MERMAID_VERSION__;

/**
 * Obsidian's own `mermaid.initialize()` call, copied from app.js of Obsidian 1.14.4
 * (`yE("/lib/mermaid.min.js", {after: …})`). Obsidian passes it itself when it loads its
 * Mermaid after this plugin; the copy is only used when Obsidian loaded first (the plugin
 * was enabled later) and to re-initialize Obsidian's instance on unload.
 */
const OBSIDIAN_CONFIG = {
	startOnLoad: false,
	securityLevel: 'strict',
	themeVariables: { fontFamily: 'var(--font-mermaid)' },
	flowchart: { useMaxWidth: false },
	sequence: { useMaxWidth: false },
	gantt: { useMaxWidth: true, axisFormatter: [['%Y-%m-%d', (d: Date) => d.getDay() === 1]] } as any,
	journey: { useMaxWidth: true },
	class: { useMaxWidth: true },
	git: { useMaxWidth: false },
	state: { useMaxWidth: true },
	er: { useMaxWidth: false },
	pie: { useMaxWidth: true },
} as MermaidConfig;  // verbatim, including Obsidian's `git` key (Mermaid's is `gitGraph`)

/**
 * Keeps 12.x looking like the 11.x Obsidian ships: 12.0 made ELK the default layout.
 * `look` and `theme` already default to classic/default in 12.1, pinned anyway so a
 * later bump cannot silently restyle every diagram.
 */
const CLASSIC: MermaidConfig = { look: 'classic', layout: 'dagre', theme: 'default' };

type State = 'waiting' | 'active' | 'failed';

interface Settings {
	/** Drag and rename anchors and components in rendered wardley-beta maps. */
	editWardley: boolean;
	/** Edit rendered flowcharts: dialogs, connecting, re-linking, groups. */
	editFlowchart: boolean;
	/** Diagrams fill the note width while Obsidian's "Readable line length" is off. */
	fullWidth: boolean;
}

const DEFAULT_SETTINGS: Settings = { editWardley: true, editFlowchart: true, fullWidth: false };

/**
 * Swaps the Mermaid that Obsidian renders with, without patching Obsidian.
 *
 * Obsidian loads `/lib/mermaid.min.js` lazily on the first diagram; the script ends with
 * `globalThis.mermaid = …`, after which Obsidian calls `mermaid.initialize(config)` and
 * renders every block through the global `mermaid.render()`. This plugin turns
 * `window.mermaid` into an accessor: Obsidian's assignment lands in the setter and is
 * kept, the getter hands out the pinned instance. Obsidian's own initialize therefore
 * configures the pinned instance, plus `CLASSIC`.
 */
export default class MermaidDirectEditPlugin extends Plugin {
	/** Obsidian's own instance, once its loader has assigned it. */
	private obsidianMermaid: Mermaid | undefined;
	private pinned: Mermaid | undefined;
	state: State = 'waiting';
	/** Obsidian had loaded its Mermaid before this plugin (enabled late, or reloaded). */
	obsidianLoadedFirst = false;
	error: string | null = null;
	settings: Settings = { ...DEFAULT_SETTINGS };
	/** The documents of the app's windows the editor is wired into (main window and pop-outs). */
	private readonly docs = new Set<Document>();
	/** Sources of the editable diagrams on screen, shared by every editor. */
	private readonly registry = new SourceRegistry();
	private readonly wardley = new WardleyEditor(this.app, this.registry, () => this.pinned, () => this.settings.editWardley);
	private readonly flowchart = new FlowchartEditor(this.app, this.registry, () => this.pinned, () => this.settings.editFlowchart);
	/** One editor per diagram type; each handles only the diagrams tagged with its kind. */
	private readonly editors: DiagramEditor<any>[] = [this.wardley, this.flowchart];
	/** The zoom (one at a time); Escape there goes to an editor first while it has something waiting. */
	private readonly zoom = new DiagramZoom(this.app, this.registry, () => this.current(), () => this.editors.some(ed => ed.busy()), () => this.editors.forEach(ed => ed.release()));

	async onload() {
		registerCliCommands(this, [{
			action: 'status',
			description: 'Pinned Mermaid version and whether it is rendering (JSON)',
			run: () => this.status(),
		}, ...wardleyCliSpecs(this.app, () => this.current())]);

		const w = window as any;
		const loadedFirst: Mermaid | undefined = w.mermaid;
		this.obsidianMermaid = loadedFirst;
		this.obsidianLoadedFirst = !!loadedFirst;
		Object.defineProperty(w, 'mermaid', {
			configurable: true,
			enumerable: true,
			get: () => this.current(),
			set: (m: Mermaid) => { this.obsidianMermaid = m; },
		});

		// Obsidian loaded its Mermaid before this plugin: its initialize() already ran on
		// its own instance, so configure the pinned one here and redraw what is open.
		if (loadedFirst) {
			this.current()?.initialize(OBSIDIAN_CONFIG);
			this.rerender();
		}

		this.addSettingTab(new MermaidDirectEditSettingTab(this.app, this));

		this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
		// Every window of the app: the main one, pop-outs already open, and each one opened later.
		this.attach(document);
		this.app.workspace.onLayoutReady(() => this.app.workspace.iterateAllLeaves(l => this.attach(l.view.containerEl.ownerDocument)));
		this.registerEvent(this.app.workspace.on('window-open', (_w, win) => this.attach(win.document)));
		this.registerEvent(this.app.workspace.on('window-close', (_w, win) => { this.docs.delete(win.document); }));
	}

	/**
	 * Wires the editor into one window of the app. A pop-out window has a document of its own,
	 * and events there never reach the main document's listeners: until 0.16.1 a map in a
	 * pop-out rendered but could not be edited.
	 */
	private attach(doc: Document) {
		if (this.docs.has(doc)) return;
		this.docs.add(doc);
		this.applyEditClass();
		// Capture phase: Live Preview would otherwise take the gesture and open the source.
		const opts = { capture: true };
		// The zoom buttons first: nothing else (an editor, Live Preview) may see a press on them.
		for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'] as const) {
			this.registerDomEvent(doc, type, this.onZoomButton, opts);
		}
		// Buttons for a drawing the after-render step missed (reading view recycles drawn boxes).
		this.registerDomEvent(doc, 'pointerover', this.onPointerOver, opts);
		for (const ed of this.editors) {
			this.registerDomEvent(doc, 'pointerdown', ed.onPointerDown, opts);
			this.registerDomEvent(doc, 'pointermove', ed.onPointerMove, opts);
			this.registerDomEvent(doc, 'pointerup', ed.onPointerUp, opts);
			this.registerDomEvent(doc, 'pointercancel', ed.onPointerCancel, opts);
			for (const type of ['mousedown', 'mouseup', 'click'] as const) {
				this.registerDomEvent(doc, type, ed.onSwallow, opts);
			}
			this.registerDomEvent(doc, 'dblclick', ed.onDblClick, opts);
			this.registerDomEvent(doc, 'contextmenu', ed.onContextMenu, opts);
			this.registerDomEvent(doc, 'touchstart', ed.onTouchStart, { capture: true, passive: false });
			this.registerDomEvent(doc, 'keydown', ed.onKeyDown);
		}
	}

	async setEditWardley(on: boolean) {
		this.settings.editWardley = on;
		this.applyEditClass();
		await this.saveData(this.settings);
	}

	async setEditFlowchart(on: boolean) {
		this.settings.editFlowchart = on;
		this.applyEditClass();
		await this.saveData(this.settings);
	}

	async setFullWidth(on: boolean) {
		this.settings.fullWidth = on;
		this.applyEditClass();
		await this.saveData(this.settings);
	}

	/** Body classes for the settings; `styles.css` does the rest, so a change needs no redraw. */
	private applyEditClass() {
		for (const doc of this.docs) {
			doc.body.toggleClass('mp-wardley-edit', this.settings.editWardley);
			doc.body.toggleClass('mp-flowchart-edit', this.settings.editFlowchart);
			doc.body.toggleClass('mde-full-width', this.settings.fullWidth);
		}
	}

	/** A press on a "Zoom in" button: the zoom opens on click, every other event of the press is swallowed. */
	private onZoomButton = (e: MouseEvent) => {
		const button = isElement(e.target) ? e.target.closest('.mde-zoom-button') : null;
		if (!button) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		const box = e.type === 'click' ? boxOfZoomButton(button) : null;
		if (box) void this.zoom.open(box);
	};

	/** Idempotent and a few lookups only, so it runs on every hover: Live Preview may rebuild a block's toolbar around the same drawing. */
	private onPointerOver = (e: PointerEvent) => {
		const box = boxAt(e.target);
		if (box && !box.closest('.mde-zoom')) decorate(box);
	};

	/**
	 * After a render: once Obsidian has inserted the drawing (its own code continues right after the
	 * render resolves), it gets its buttons. The zoom decorates its own drawings.
	 */
	private rendered(id: string) {
		if (id.startsWith(ZOOM_ID_PREFIX)) return;
		let tries = 0;
		const look = () => {
			for (const doc of this.docs) {
				const svg = doc.getElementById(id);
				const box = svg?.parentElement;
				if (svg && box?.hasClass('mermaid') && !svg.closest('.mde-zoom')) return decorate(box);
			}
			// Not inserted yet (a block outside the viewport waits for its widget): a few frames more.
			if (++tries < 10) window.requestAnimationFrame(look);
		};
		window.setTimeout(look, 0);
	}

	onunload() {
		this.zoom.close();
		for (const ed of this.editors) ed.destroy(this.docs);
		undecorate(this.docs);
		const w = window as any;
		delete w.mermaid;
		if (this.obsidianMermaid) {
			// Its initialize() may have gone to the pinned instance instead.
			this.obsidianMermaid.initialize(OBSIDIAN_CONFIG);
			w.mermaid = this.obsidianMermaid;
		}
		// Never loaded: leave it undefined, Obsidian's loader assigns and initializes it.
		for (const doc of this.docs) {
			doc.body.removeClass('mp-wardley-edit');
			doc.body.removeClass('mp-flowchart-edit');
			doc.body.removeClass('mde-full-width');
		}
		this.docs.clear();
		// No redraw here: Obsidian's bundled Mermaid cannot draw wardley-beta, so a redraw on
		// every plugin reload or update flashed "Error parsing Mermaid diagram!" until the new
		// instance redrew (measured 2026-10-10, UnknownDiagramError in the console). Diagrams
		// already on screen stay as drawn; the next render uses Obsidian's own Mermaid.
	}

	/** The instance Obsidian renders with: the pinned one, or Obsidian's own as fallback. */
	private current(): Mermaid | undefined {
		if (this.state === 'failed') return this.obsidianMermaid;
		if (!this.pinned) {
			try {
				this.pinned = this.loadPinned();
				this.state = 'active';
			} catch (e) {
				this.state = 'failed';
				this.error = e instanceof Error ? e.message : String(e);
				console.error(`[mermaid-direct-edit] Mermaid ${PINNED_VERSION} failed to load, Obsidian's own Mermaid stays in use:`, e);
				return this.obsidianMermaid;
			}
		}
		return this.pinned;
	}

	/** Evaluated on first use only, so startup does not pay for a diagram nobody opened. */
	private loadPinned(): Mermaid {
		const m: Mermaid = require('mermaid').default;
		const initialize = m.initialize.bind(m);
		m.initialize = (config: MermaidConfig) => initialize({ ...config, ...CLASSIC });
		wrapRender(m, this.registry, [wardleyRender, flowchartRender], id => this.rendered(id));
		return m;
	}

	/** Same redraw Obsidian triggers when the vault's Mermaid permission is toggled. */
	private rerender() {
		this.app.workspace.trigger('post-processor-change');
	}

	status() {
		return {
			pinnedVersion: PINNED_VERSION,
			state: this.state,
			obsidianMermaidLoaded: !!this.obsidianMermaid,
			obsidianLoadedFirst: this.obsidianLoadedFirst,
			editWardley: this.settings.editWardley,
			editFlowchart: this.settings.editFlowchart,
			fullWidth: this.settings.fullWidth,
			rendering: this.state === 'active' ? `pinned ${PINNED_VERSION}` : this.obsidianMermaid ? 'obsidian' : 'none yet',
			error: this.error,
		};
	}
}

class MermaidDirectEditSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MermaidDirectEditPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.status();
		const state = s.state === 'active'
			? 'Rendering all mermaid blocks.'
			: s.state === 'failed'
				? `Failed to load, Obsidian's own Mermaid is in use: ${s.error}`
				: 'Loads on the first mermaid diagram.';
		new Setting(containerEl)
			.setName(`Mermaid ${s.pinnedVersion}`)
			.setDesc(`Pinned in this build. ${state} Disable the plugin to return to Obsidian's bundled Mermaid.`);
		new Setting(containerEl)
			.setName('Edit Wardley maps')
			.setDesc('Drag elements, labels, arrow tips and link ends; double-click (double-tap) an element for its dialog; the menu button at the top left of a map adds elements. Changes go into the code block and can be undone.')
			.addToggle(t => t.setValue(this.plugin.settings.editWardley).onChange(v => this.plugin.setEditWardley(v)));
		new Setting(containerEl)
			.setName('Edit flowcharts')
			.setDesc('Double-click (double-tap) a node or a group\'s title, or click (tap) a link, for its dialog; right-click for a menu. Drag from the + beside a node to link it (into free space: a new node); drag a link\'s end onto another node; drag a node onto a group to move it there. The menu button at the top left adds nodes and groups and sets the direction. On a phone, swipes always scroll: edit with taps. Changes go into the code block and can be undone.')
			.addToggle(t => t.setValue(this.plugin.settings.editFlowchart).onChange(v => this.plugin.setEditFlowchart(v)));
		new Setting(containerEl)
			.setName('Full-width diagrams without readable line length')
			.setDesc('While Obsidian\'s "Readable line length" is off, every diagram fills the width of the note, small ones included (for presenting, e.g. on a second screen). With it on, diagrams keep their usual size. Switch with the command "Toggle readable line length"; a hotkey for it can be set under Settings → Hotkeys.')
			.addToggle(t => t.setValue(this.plugin.settings.fullWidth).onChange(v => this.plugin.setFullWidth(v)));
	}
}
