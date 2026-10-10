import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { Mermaid, MermaidConfig } from 'mermaid';
import { registerCliCommands } from './cli';
import { WardleyEditor } from './wardley-editor';

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
}

const DEFAULT_SETTINGS: Settings = { editWardley: true };

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
	private wardley = new WardleyEditor(this.app, () => this.pinned, () => this.settings.editWardley);

	async onload() {
		registerCliCommands(this, [{
			action: 'status',
			description: 'Pinned Mermaid version and whether it is rendering (JSON)',
			run: () => this.status(),
		}]);

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
		this.applyEditClass();
		// Capture phase: Live Preview would otherwise take the gesture and open the source.
		const opts = { capture: true };
		this.registerDomEvent(document, 'pointerdown', this.wardley.onPointerDown, opts);
		this.registerDomEvent(document, 'pointermove', this.wardley.onPointerMove, opts);
		this.registerDomEvent(document, 'pointerup', this.wardley.onPointerUp, opts);
		this.registerDomEvent(document, 'pointercancel', this.wardley.onPointerCancel, opts);
		for (const type of ['mousedown', 'mouseup', 'click'] as const) {
			this.registerDomEvent(document, type, this.wardley.onSwallow, opts);
		}
		this.registerDomEvent(document, 'dblclick', this.wardley.onDblClick, opts);
		this.registerDomEvent(document, 'touchstart', this.wardley.onTouchStart, { capture: true, passive: false });
		this.registerDomEvent(document, 'keydown', this.wardley.onKeyDown);
	}

	async setEditWardley(on: boolean) {
		this.settings.editWardley = on;
		this.applyEditClass();
		await this.saveData(this.settings);
	}

	private applyEditClass() {
		document.body.toggleClass('mp-wardley-edit', this.settings.editWardley);
	}

	onunload() {
		this.wardley.destroy();
		const w = window as any;
		delete w.mermaid;
		if (this.obsidianMermaid) {
			// Its initialize() may have gone to the pinned instance instead.
			this.obsidianMermaid.initialize(OBSIDIAN_CONFIG);
			w.mermaid = this.obsidianMermaid;
		}
		// Never loaded: leave it undefined, Obsidian's loader assigns and initializes it.
		document.body.removeClass('mp-wardley-edit');
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
		this.wardley.wrapRender(m);
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
			.setDesc('Drag elements, labels, arrow tips and link ends; double-click (double-tap) an element for its dialog; the legend in a bottom corner of a map adds elements. Changes go into the code block and can be undone.')
			.addToggle(t => t.setValue(this.plugin.settings.editWardley).onChange(v => this.plugin.setEditWardley(v)));
	}
}
