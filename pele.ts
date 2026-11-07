import type { Mermaid } from 'mermaid';
import { decorate } from './actions';

/**
 * Obsidian 1.15 and later (measured in `app.js` of 1.15.0): Mermaid is gone from Obsidian. Its
 * own renderer Pele (`/lib/pele.min.js`, loaded on the first diagram, a global `var pele`) draws
 * every ```` ```mermaid ```` block through `pele.mount(box, source, options)` and keeps the handle
 * it returns; `window.mermaid` is only a shim for plugins and never called by Obsidian itself.
 *
 * `PeleHook` swaps the global for a proxy whose `mount` returns a {@link Drawing}: the block drawn
 * with the pinned Mermaid the way Obsidian 1.14 drew it, so the render hooks, the editors and the
 * buttons work unchanged. Everything else of Pele is passed through. Like the `window.mermaid`
 * accessor before it, nothing of Obsidian is patched: `pele` is a writable global, `pele.mount`
 * itself is not (a getter of an esbuild namespace object).
 */

/** The handle `pele.mount` returns. Obsidian 1.15.0 uses `source`, `update` and `refresh`. */
export interface PeleHandle {
	readonly source: string;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly zoom?: unknown;
	update(source: string, options?: PeleOptions): void;
	refresh(): void;
	destroy(): void;
}

/** Obsidian's options for a mount (zoom labels, math, sanitize, onRender); passed on to Pele as they are. */
export type PeleOptions = Record<string, unknown> & { onRender?: (result: unknown) => void };

interface Pele {
	mount(box: HTMLElement, source: string, options?: PeleOptions): PeleHandle;
}

/** Render ids of the drawings, skipped by the after-render step in `main.ts` (a drawing decorates itself). */
export const DRAWING_ID_PREFIX = 'mde-draw-';

/** Every proxy of any hook to the Pele behind it: a proxy assigned back to the global is never taken for Pele. */
const targets = new WeakMap<object, Pele>();
/** The drawing in each box, for the post-processor that lets a PDF export wait (`settled`). */
const drawingOf = new WeakMap<HTMLElement, Drawing>();

export class PeleHook {
	/** Pele as Obsidian loaded it, once it has. */
	original: Pele | undefined;
	private proxy: Pele | undefined;
	/** The global is this hook's accessor (Pele not loaded yet when the hook went in, or re-created on unload). */
	private accessor = false;
	private on = false;
	/** Renders the plugin made in Pele's place since it loaded (status). */
	renders = 0;

	/**
	 * `mermaid`: the pinned instance, configured, or undefined (failed to load: Pele draws).
	 * `global`: the object holding `pele` (the window; a test passes its own).
	 */
	constructor(private readonly mermaid: () => Mermaid | undefined, private readonly global: object = window) {}

	/** Whether drawings are made by the plugin (installed and not unloaded). */
	get live() { return this.on; }

	/** Installs the hook. Returns false when the global cannot be replaced (then Pele draws). */
	install(): boolean {
		const w = this.global as Record<string, unknown>;
		const d = Object.getOwnPropertyDescriptor(w, 'pele');
		if (!d || d.configurable) {
			const loaded = d ? ('value' in d ? d.value : d.get?.call(w)) : undefined;
			Object.defineProperty(w, 'pele', {
				configurable: true,
				enumerable: true,
				get: () => this.proxy ?? this.original,
				// Pele's script ends in `var pele = …`: with this accessor in place that lands here.
				set: (p: unknown) => this.adopt(p),
			});
			this.accessor = true;
			if (loaded) this.adopt(loaded);
			this.on = true;
			return true;
		}
		// Loaded before the plugin: a `var` global, writable but not configurable.
		if (!d.writable || !d.value) return false;
		this.adopt(d.value);
		w.pele = this.proxy;
		this.on = true;
		return true;
	}

	/** Puts Pele back. Drawings already made hand over to Pele on their next update. */
	uninstall() {
		this.on = false;
		const w = this.global as Record<string, unknown>;
		if (this.accessor) {
			delete w.pele;
			if (this.original) w.pele = this.original;
		} else if (this.original && w.pele === this.proxy) {
			w.pele = this.original;
		}
		this.accessor = false;
	}

	/** The Mermaid a drawing is made with right now; undefined hands it to Pele. */
	drawsWith(): Mermaid | undefined {
		return this.on ? this.mermaid() : undefined;
	}

	/**
	 * For a post-processor that runs after Obsidian's own: the drawings in `el` once drawn, or null
	 * when there is nothing to wait for. Obsidian 1.15 expects `pele.mount` to draw at once, so its
	 * own post-processor returns nothing, and a PDF export (which waits for the promises
	 * post-processors return, then prints) would print empty boxes; 1.14 returned its render's
	 * promise. Before Pele is loaded, Obsidian mounts only once it is, so the blocks still waiting
	 * for that are awaited first (bounded: 5 s).
	 */
	settled(el: HTMLElement): Promise<void> | null {
		if (!this.on) return null;
		const pending = () => Array.from(el.querySelectorAll<HTMLElement>('.mermaid')).map(box => drawingOf.get(box)?.settled).filter(p => !!p);
		if (this.original || !el.querySelector('code.language-mermaid')) {
			const now = pending();
			return now.length ? Promise.all(now).then(() => undefined) : null;
		}
		return (async () => {
			const win = el.ownerDocument.defaultView ?? window;
			for (let i = 0; i < 100 && (!this.original || el.querySelector('code.language-mermaid')); i++) {
				await new Promise(resolve => win.setTimeout(resolve, 50));
			}
			await Promise.all(pending());
		})();
	}

	private adopt(p: unknown) {
		if (!p || typeof p !== 'object') {
			this.original = this.proxy = undefined;
			return;
		}
		// A proxy (this hook's or an earlier one's) assigned back to the global: the Pele behind it.
		const pele = targets.get(p) ?? (p as Pele);
		this.original = pele;
		// A proxy, so whatever a later Pele adds is passed through unchanged. `mount` is an accessor
		// with a getter on Pele's namespace object, so returning another function breaks no invariant.
		this.proxy = new Proxy(pele, { get: (target, key) => (key === 'mount' ? this.mount : Reflect.get(target, key)) });
		targets.set(this.proxy, pele);
	}

	private mount = (box: HTMLElement, source: string, options?: PeleOptions): PeleHandle => {
		try {
			return new Drawing(this, box, source, options ?? {});
		} catch (e) {
			console.error('[mermaid-direct-edit] drawing failed, Obsidian\'s renderer draws this diagram:', e);
			return this.original!.mount(box, source, options);
		}
	};
}

let renders = 0;

/**
 * One block drawn into Obsidian's `.mermaid` box, the box Obsidian created and keeps. Obsidian
 * updates it in place (Live Preview on every change of the block, reading view when it reuses a
 * box for another block), so one drawing at a time and the newest source wins, as in the zoom.
 * While the hook is not live (unloaded, or the pinned Mermaid failed) the block goes to Pele.
 */
class Drawing implements PeleHandle {
	private src: string;
	private options: PeleOptions;
	/** Pele's own handle once the block was handed over. */
	private pele: PeleHandle | null = null;
	private last: { svg: string } | undefined;
	private failure: unknown;
	private busy = false;
	private again = false;
	private gone = false;
	/** Resolves once the newest source is drawn (or failed, or handed over); a PDF export waits on it. */
	settled: Promise<void> = Promise.resolve();

	constructor(private readonly hook: PeleHook, private readonly box: HTMLElement, source: string, options: PeleOptions) {
		this.src = source;
		this.options = options;
		drawingOf.set(box, this);
		this.update(source, options);
	}

	get source() { return this.pele ? this.pele.source : this.src; }
	get result() { return this.pele ? this.pele.result : this.last; }
	get error() { return this.pele ? this.pele.error : this.failure; }
	get zoom() { return this.pele?.zoom; }

	update(source: string, options: PeleOptions = this.options) {
		this.src = source;
		this.options = options;
		if (this.gone) return;
		const m = this.hook.drawsWith();
		if (!m) {
			this.handOver();
			return;
		}
		this.settled = this.draw(m);
	}

	/**
	 * Obsidian calls it when the box is inserted and on a CSS change: the buttons again (Live Preview
	 * may have built its toolbar meanwhile), never once the plugin is unloaded (its buttons are gone).
	 */
	refresh() {
		if (this.pele) this.pele.refresh();
		else if (this.hook.live && this.box.querySelector(':scope > svg')) decorate(this.box);
	}

	destroy() {
		this.gone = true;
		this.pele?.destroy();
	}

	private handOver() {
		if (this.pele) {
			this.pele.update(this.src, this.options);
			return;
		}
		const pele = this.hook.original;
		// Pele replaces the box's children, the plugin's drawing and buttons with them.
		if (pele) this.pele = pele.mount(this.box, this.src, this.options);
	}

	private draw(m: Mermaid): Promise<void> {
		if (this.busy) { this.again = true; return this.settled; }
		this.busy = true;
		return (async () => {
			try {
				do {
					this.again = false;
					await this.render(m, this.src);
				} while (this.again && !this.gone);
			} finally {
				this.busy = false;
			}
		})();
	}

	/**
	 * Obsidian 1.14.5's block render (`app.js`), into the box Obsidian 1.15 gives: Mermaid draws in a
	 * hidden box as wide as the block, the SVG string goes into the box, then its internal links and
	 * markers are fixed up. A parse error shows as text in place of the drawing.
	 */
	private async render(m: Mermaid, src: string) {
		const win = this.box.ownerDocument.defaultView ?? window;
		const width = this.box.clientWidth || this.box.parentElement?.clientWidth || win.innerWidth;
		const id = `${DRAWING_ID_PREFIX}${(++renders).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		const measure = document.body.createDiv('mermaid');
		measure.setCssStyles({ width: `${width}px`, visibility: 'hidden', position: 'absolute' });
		try {
			const { svg } = await m.render(id, src, measure);
			if (this.gone || this.pele || src !== this.src) return;  // superseded: the loop draws the newest
			if (!this.hook.live) { this.handOver(); return; }  // unloaded meanwhile: Pele draws it
			this.box.querySelector(':scope > svg, :scope > .mde-render-error')?.remove();
			this.box.insertAdjacentHTML('afterbegin', svg);
			const drawn = this.box.querySelector<SVGSVGElement>(':scope > svg');
			if (drawn) fixUp(drawn, id);
			this.last = { svg };
			this.failure = undefined;
			this.hook.renders++;
			decorate(this.box);
			// Obsidian's own step after a render: links that are not internal get `external-link`.
			this.options.onRender?.(this.last);
		} catch (e) {
			document.getElementById(`d${id}`)?.remove();
			console.error(e);
			if (this.gone || this.pele || src !== this.src) return;
			if (!this.hook.live) { this.handOver(); return; }
			this.failure = e;
			this.last = undefined;
			this.box.empty();
			const text = (e as { str?: string })?.str || (e instanceof Error ? e.message : String(e));
			this.box.createEl('pre', { cls: 'mde-render-error' }).createEl('code', { text: `Error parsing Mermaid diagram!\n\n${text}` });
		} finally {
			measure.detach();
		}
	}
}

/** Obsidian 1.14.5's fix-ups after a render: internal links in labels, SVG links, marker ids. */
function fixUp(svg: SVGSVGElement, id: string) {
	// A node with `class … internal-link` (flowcharts): its label becomes a link Obsidian follows.
	// The label goes into `data-href` only, which Obsidian's link handling reads first: as `href`
	// (1.14.5) a label `javascript:…` was a link that ran when clicked, since it is written after
	// Mermaid's sanitizer (security review 0.28.0). A whole class word, as Pele matches it.
	for (const div of Array.from(svg.querySelectorAll<HTMLElement>('[*|class~="internal-link"] > g.label foreignObject > div'))) {
		const text = div.textContent;
		if (!text) continue;
		div.empty();
		div.createEl('a', { cls: 'internal-link', text, attr: { 'data-href': text } });
	}
	for (const el of Array.from(svg.querySelectorAll('a'))) {
		if (!el.instanceOf(SVGAElement)) continue;
		const a = el as unknown as SVGAElement;
		if (a.href && !a.href.baseVal) a.href.baseVal = a.getAttribute('href') ?? '';
	}
	namespaceMarkers(svg, id);
}

/**
 * Marker ids made unique per drawing, so two drawings in one note never share one (a marker in a
 * hidden drawing is not drawn): `<id>-<marker id>`, in the references and the drawing's style
 * sheet too. Mermaid 12 already namespaces most with the svg id: those stay, which `styles.css`
 * relies on (`marker[id^="link-arrow-"]`). Like 1.14.5, only in a drawing with a style sheet.
 */
export function namespaceMarkers(svg: Element, id: string) {
	const style = svg.querySelector('style');
	if (!style) return;
	let css = style.textContent ?? '';
	const before = css;
	for (const marker of Array.from(svg.querySelectorAll('marker'))) {
		const old = marker.id;
		if (!old || old.includes(id)) continue;
		const fresh = `${id}-${old}`;
		marker.id = fresh;
		for (const attr of ['marker-start', 'marker-end']) {
			for (const el of Array.from(svg.querySelectorAll(`[${attr}="url(#${CSS.escape(old)})"]`))) el.setAttribute(attr, `url(#${fresh})`);
		}
		css = css.replace(new RegExp(`#${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w|-)`, 'g'), `#${fresh}`);
	}
	if (css !== before) style.textContent = css;
}
