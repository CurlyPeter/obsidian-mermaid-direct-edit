import { App, EventRef, Notice, Platform } from 'obsidian';
import type { Mermaid } from 'mermaid';
import { STATIC, actionButton, decorate, shareButton } from './actions';
import { followBlock, mermaidBlocks } from './blocks';
import { fitInside } from './geometry';
import { SourceRegistry } from './render';
import { Origin, originOf, zoomViews } from './write';

/** Render ids of the zoom's drawings; the plugin's after-render step leaves them to the zoom. */
export const ZOOM_ID_PREFIX = 'mde-zoom-';

let renders = 0;

/**
 * A diagram drawn as large as the window allows, in the look of Obsidian's image zoom: a black
 * backdrop, the diagram on a panel in the note's colour (Mermaid draws on a transparent ground,
 * black on black otherwise) with the image zoom's margin, the same buttons at the same places.
 * See DEV.md → "Zoom and the menu button (0.24.0)".
 *
 * The zoom draws the block again from its source with the plugin's Mermaid, so the drawing is
 * tagged like any other and the editors work on it as in the note; `write.ts` sends its edits to
 * the note it came from (`zoomViews`). It follows its block: after every change of the note (an
 * edit here or in the note, Undo, Cmd+Z, sync) it reads the block again and redraws when it
 * changed. The `.mermaid` box stays the same element and only the SVG in it is swapped, so a
 * legend action armed before a redraw still counts afterwards. A diagram whose block is not found
 * in a note (an embed, a canvas, a callout) is zoomed as a picture only (`mde-static`).
 */
export class DiagramZoom {
	private el: HTMLElement | null = null;
	private panel: HTMLElement | null = null;
	private box: HTMLElement | null = null;
	private origin: Origin | null = null;
	/** The source the zoom shows (or is drawing). */
	private src = '';
	private drawing = false;
	private again = false;
	private refs: { off: () => void }[] = [];
	private followTimer = 0;
	private downOnBackdrop = false;
	/** The window's app container, made inert while the zoom is open (it was not before). */
	private inert: HTMLElement | null = null;

	constructor(
		private app: App,
		private registry: SourceRegistry,
		private mermaid: () => Mermaid | undefined,
		/** Whether an editor has something waiting (Escape goes to it first). */
		private busy: () => boolean,
		/** The zoom opened or closed: editors drop what they keep armed for the other surface. */
		private toggled: () => void,
	) {}

	isOpen(): boolean {
		return !!this.el;
	}

	/**
	 * Zooms the diagram in `box` (a `.mermaid` with a rendered SVG). It draws the block as the
	 * note holds it now, which may be newer than the drawing on screen.
	 */
	async open(box: HTMLElement) {
		const svg = box.querySelector(':scope > svg');
		const drawn = svg ? this.registry.zoomSourceOf(svg) : undefined;
		const found = originOf(this.app, this.registry, box, drawn);
		const src = found?.src ?? drawn;
		if (src === undefined) {
			new Notice('Mermaid: this diagram was drawn before the plugin was loaded and is redrawn now, please try again.');
			this.app.workspace.trigger('post-processor-change');
			return;
		}
		this.close();
		this.toggled();
		this.origin = found?.origin ?? null;
		this.src = src;
		const doc = box.ownerDocument;
		const el = (this.el = doc.body.createDiv({ cls: 'mde-zoom', attr: { tabindex: '-1' } }));
		const backdrop = el.createDiv('mde-zoom-bg');
		const panel = (this.panel = el.createDiv('mde-zoom-panel'));
		this.box = panel.createDiv({ cls: `mermaid mde-zoom-diagram${this.origin ? '' : ` ${STATIC}`}` });
		// The image zoom's two buttons at the same place: Zoom out where Zoom in was, then the source.
		const right = panel.createDiv('mde-actions mde-actions-right');
		shareButton(right);  // handled by main.ts with the other buttons
		actionButton(right, 'lucide-zoom-out', 'Zoom out', 'mde-unzoom-button').addEventListener('click', () => this.close());
		if (this.origin?.view.getMode() === 'source') {
			actionButton(right, 'lucide-code-2', 'Edit this block', 'mde-source-button').addEventListener('click', () => this.editSource());
		}
		// A click on the backdrop closes, as in the image zoom; only a press that started there (a
		// drag released over it is not one).
		el.addEventListener('pointerdown', e => { this.downOnBackdrop = e.target === el || e.target === backdrop; });
		el.addEventListener('click', e => { if (this.downOnBackdrop && (e.target === el || e.target === backdrop)) this.close(); });
		if (this.origin) zoomViews.set(el, { view: this.origin.view, file: this.origin.file });
		// Nothing behind the zoom takes focus or input meanwhile: Tab must not lead into the hidden
		// note, where a Cmd+Z would undo unseen (review 0.24.0, I-2). Dialogs, menus and notices are
		// outside the app container and stay usable.
		const app = doc.body.querySelector<HTMLElement>(':scope > .app-container');
		if (app && !app.inert) {
			app.inert = true;
			this.inert = app;
		}
		const win = doc.defaultView ?? window;
		this.listen(doc, 'keydown', this.onKey as EventListener, true);
		this.listen(win, 'resize', this.fit);
		if (this.origin) {
			const { view, file } = this.origin;
			this.on(this.app.workspace.on('editor-change', (_e, info) => { if (info === view) this.schedule(); }), this.app.workspace);
			this.on(this.app.vault.on('modify', f => { if (f === file) this.schedule(); }), this.app.vault);
		}
		this.on(this.app.workspace.on('layout-change', this.check), this.app.workspace);
		this.on(this.app.workspace.on('file-open', this.check), this.app.workspace);
		el.focus({ preventScroll: true });
		await this.draw(src);
	}

	/** Closes the zoom (Zoom out, Escape, the backdrop, its note gone, unload). */
	close() {
		const el = this.el;
		if (!el) return;
		for (const r of this.refs) r.off();
		this.refs = [];
		(el.ownerDocument.defaultView ?? window).clearTimeout(this.followTimer);
		zoomViews.delete(el);
		if (this.inert) this.inert.inert = false;
		this.inert = null;
		el.remove();
		this.el = this.panel = this.box = null;
		this.origin = null;
		this.toggled();
	}

	/** Draws `src` into the zoom; one drawing at a time, the newest source wins. */
	private async draw(src: string) {
		this.src = src;
		if (this.drawing) { this.again = true; return; }
		this.drawing = true;
		try {
			do {
				this.again = false;
				await this.render(this.src);
			} while (this.again && this.el);
		} finally {
			this.drawing = false;
		}
	}

	/**
	 * Renders the way Obsidian does: in a hidden box as wide as the space the diagram gets, then
	 * the SVG string into the zoom's box. Same Mermaid instance and configuration as the note
	 * (`securityLevel: strict`), and through the plugin's render hook, which tags it for the editors.
	 */
	private async render(src: string) {
		const m = this.mermaid();
		const box = this.box;
		if (!m || !box || !this.el) return;
		const doc = box.ownerDocument;
		const measure = doc.body.createDiv('mermaid');
		measure.setCssStyles({ position: 'absolute', visibility: 'hidden', width: `${Math.max(320, this.space().width)}px` });
		const id = ZOOM_ID_PREFIX + String(++renders);
		try {
			const { svg } = await m.render(id, src, measure);
			if (box !== this.box || src !== this.src) return;  // closed or superseded meanwhile
			box.querySelector(':scope > svg, :scope > .mde-zoom-error')?.remove();
			box.insertAdjacentHTML('afterbegin', svg);
			decorate(box, true);
			this.fit();
		} catch (e) {
			doc.getElementById(`d${id}`)?.remove();
			if (box !== this.box) return;
			box.querySelector(':scope > svg, :scope > .mde-zoom-error')?.remove();
			box.prepend(createDiv({ cls: 'mde-zoom-error', text: `Error parsing Mermaid diagram!\n\n${e instanceof Error ? e.message : String(e)}` }));
		} finally {
			measure.remove();
		}
	}

	/** The panel as large as the window allows (minus the margin), in the diagram's aspect. */
	private fit = () => {
		const svg = this.box?.querySelector<SVGSVGElement>(':scope > svg');
		if (!svg || !this.panel) return;
		const vb = svg.viewBox.baseVal;
		let w = vb?.width ?? 0, h = vb?.height ?? 0;
		if (!(w > 0 && h > 0)) {
			const r = svg.getBoundingClientRect();
			w = r.width;
			h = r.height;
		}
		const { width, height } = fitInside(this.space().width, this.space().height, w, h);
		this.panel.setCssStyles({ width: `${width}px`, height: `${height}px` });
	};

	/** The space inside the zoom's padding (safe areas and the image zoom's margin). */
	private space(): { width: number; height: number } {
		const el = this.el;
		if (!el) return { width: 0, height: 0 };
		const cs = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
		const px = (v: string) => parseFloat(v) || 0;
		return {
			width: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
			height: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
		};
	}

	private schedule() {
		if (!this.el) return;
		const win = this.el.ownerDocument.defaultView ?? window;
		win.clearTimeout(this.followTimer);
		this.followTimer = win.setTimeout(() => void this.follow(), 40);
	}

	/** After a change of the note: the block again, redrawn when it changed; closed when it is gone. */
	private async follow() {
		const o = this.origin;
		if (!o || !this.el) return;
		if (o.view.file !== o.file) return this.close();
		// Reading view writes the file; Live Preview's buffer is the newest text (not saved yet).
		const text = o.view.getMode() === 'preview' ? await this.app.vault.cachedRead(o.file) : o.view.editor.getValue();
		if (this.origin !== o) return;
		const bodies = mermaidBlocks(text).map(b => b.body);
		const i = followBlock(bodies, o.count, o.index, this.src);
		if (i === null) {
			new Notice('Mermaid: the zoomed diagram is no longer in the note, the zoom was closed.');
			return this.close();
		}
		o.index = i;
		o.count = bodies.length;
		if (bodies[i] !== this.src) await this.draw(bodies[i]);
	}

	/**
	 * Its note closed, another note opened in that tab, or its window closed (a picture-only zoom in
	 * a pop-out, review 0.24.0, I-3): the zoom has nothing to show any more.
	 */
	private check = () => {
		const o = this.origin;
		if ((this.el && !this.el.isConnected) || (o && (o.view.file !== o.file || !o.view.containerEl.isConnected))) this.close();
	};

	/**
	 * Keys while the zoom is open (capture phase, before the editors). Escape closes it, unless an
	 * editor has something waiting: then Escape is the editor's (it drops the stub, the armed
	 * action, the legend), and the next one closes. Cmd+Z / Shift+Cmd+Z undo and redo in the note's
	 * editor (Live Preview), which has no focus while the zoom is open. A dialog or menu above the
	 * zoom handles its own keys, and so does anything outside the zoom that has the focus.
	 */
	private onKey = (e: KeyboardEvent) => {
		const el = this.el;
		if (!el || e.defaultPrevented) return;
		const doc = el.ownerDocument;
		if (doc.querySelector('.modal-container, body > .menu')) return;
		// Not `instanceof Node`: in a pop-out the target belongs to that window's realm.
		const target = e.target as Node | null;
		if (!(target === doc.body || (target?.nodeType && el.contains(target)))) return;
		if (e.key === 'Escape') {
			if (this.busy()) return;
			e.preventDefault();
			e.stopPropagation();
			this.close();
			return;
		}
		const k = e.key.toLowerCase();
		if (!(Platform.isMacOS ? e.metaKey : e.ctrlKey) || e.altKey || (k !== 'z' && k !== 'y')) return;
		const view = this.origin?.view;
		if (!view || view.getMode() !== 'source') return;
		e.preventDefault();
		e.stopPropagation();
		if (k === 'y' || e.shiftKey) view.editor.redo();
		else view.editor.undo();
	};

	/** Live Preview: closes the zoom and puts the cursor into the block, which shows its source. */
	private editSource() {
		const o = this.origin;
		this.close();
		if (!o || o.view.getMode() !== 'source') return;
		const editor = o.view.editor;
		const block = mermaidBlocks(editor.getValue())[o.index];
		if (!block) return;
		const pos = editor.offsetToPos(block.from);
		editor.setCursor(pos);
		editor.focus();
		editor.scrollIntoView({ from: pos, to: pos }, true);
	}

	private listen(target: EventTarget, type: string, fn: EventListener, capture = false) {
		target.addEventListener(type, fn, capture);
		this.refs.push({ off: () => target.removeEventListener(type, fn, capture) });
	}

	private on(ref: EventRef, events: { offref(ref: EventRef): void }) {
		this.refs.push({ off: () => events.offref(ref) });
	}
}
