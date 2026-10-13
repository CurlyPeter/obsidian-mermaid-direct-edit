import { App, MarkdownView, Modal, Notice } from 'obsidian';
import type { Mermaid } from 'mermaid';
import { EditError } from './blocks';
import { DBLCLICK_MS, STUB_GRAB, TapDetector } from './geometry';
import { EditCtx, Gesture, NewLinkDrag, Stub, Surface } from './gestures';
import { Legend, LegendItem } from './legend';
import { KEY_ATTR, KIND_ATTR, SourceRegistry, diagramIn, diagramOf, isElement } from './render';
import { viewOf, writeBlock } from './write';

const svgCursor = (body: string, fallback: string) =>
	`url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'>${body}</svg>`)}") 10 10, ${fallback}`;
/** Red ✕: a click deletes. */
export const CURSOR_DELETE = svgCursor("<circle cx='10' cy='10' r='8' fill='#d33' stroke='white' stroke-width='1.5'/><path d='M6.6 6.6l6.8 6.8M13.4 6.6l-6.8 6.8' stroke='white' stroke-width='2'/>", 'pointer');
/** "−": a click takes a component out of the group being edited (not a delete: no red). */
export const CURSOR_REMOVE = svgCursor("<circle cx='10' cy='10' r='8' fill='white' stroke='#333' stroke-width='1.5'/><path d='M5.5 10h9' stroke='#333' stroke-width='2'/>", 'pointer');
/** "+": a press starts a new link. */
export const CURSOR_ADD = svgCursor("<circle cx='10' cy='10' r='8' fill='white' stroke='#333' stroke-width='1.5'/><path d='M10 5.5v9M5.5 10h9' stroke='#333' stroke-width='2'/>", 'copy');

/** How an editor names itself and its diagrams in notices. */
export interface EditorNames {
	/** Notice prefix, e.g. "Wardley map". */
	title: string;
	/** The diagram in a sentence, e.g. "map". */
	noun: string;
}

/**
 * What every graphical editor shares, whatever the diagram type: the DOM event handlers
 * (registered by main.ts in the capture phase on every window), one active gesture at a time,
 * the waiting "+" stub, the menu button's legend, double tap, swallowing the clicks a gesture leaves behind,
 * dialogs that unload closes, and `apply`, which turns every edit into a text change of the
 * block, validated by Mermaid before it is written. A subclass says what a press on its diagram
 * means (`press`, `claims`, `cursorAt`) and what its legend adds.
 */
export abstract class DiagramEditor<M extends Surface> implements EditCtx<M> {
	protected readonly legend: Legend;
	protected readonly taps = new TapDetector();
	/** The diagram container of the last tap, so a dblclick elsewhere does not claim it. */
	private tapBox: Element | null = null;
	/** The one gesture in progress (a second finger is ignored meanwhile, review finding #5). */
	protected active: Gesture | null = null;
	/** A provisional link waiting for its free end to be dragged. */
	protected stub: Stub | null = null;
	/** The click after a handled gesture targets the diagram (pointer capture); swallowed there only. */
	protected swallow: { until: number; box: Element } | null = null;
	private readonly modals = new Set<Modal>();
	/** When an unknown diagram tag last caused a redraw. */
	private staleAt = 0;
	/** The last press came from a finger or pen (notices word their hints for it). */
	protected touchSeen = false;
	/** Drawings whose "not editable" notice was shown. */
	private readonly toldBlocked = new WeakSet<SVGSVGElement>();

	constructor(
		protected app: App,
		protected registry: SourceRegistry,
		protected mermaid: () => Mermaid | undefined,
		protected enabled: () => boolean,
		/** KIND_ATTR of the diagrams this editor owns. */
		readonly kind: string,
		private names: EditorNames,
		legend: readonly LegendItem[],
	) {
		this.legend = new Legend(legend);
	}

	// ---- what a subclass decides ------------------------------------------------------------

	/** The model of an SVG of this editor's kind, or null when it is not one of this plugin load's. */
	protected abstract modelOf(svg: SVGSVGElement): M | null;
	/** A press on the diagram: start a gesture (`start`) or act; leave it alone to let Obsidian have it. */
	protected abstract press(e: PointerEvent, model: M): void;
	/** Whether a press here would be the editor's (swallows clicks, keeps a touch from scrolling); `touch`: a finger, not a mouse. */
	protected abstract claims(model: M, target: Element, x: number, y: number, touch: boolean): boolean;
	/** Inline cursor while hovering here; '' leaves it to styles.css. */
	protected abstract cursorAt(model: M, target: Element, x: number, y: number): string;
	/** A click on a legend item. */
	protected abstract legendAction(model: M, kind: string, item: Element): void;
	/** Dragging the free end of a waiting stub. */
	protected abstract stubDrag(e: PointerEvent, stub: Stub): Gesture;
	/** Why this diagram cannot be edited although it is tagged (it renders, the editor stays off), or null. */
	protected blockedReason(_model: M): string | null {
		return null;
	}
	/**
	 * A press while a stub waits, not on its handle: true when the subclass took it (a press on
	 * another element links to it: click, then click). Otherwise the stub is dropped.
	 */
	protected stubPress(_e: PointerEvent, _stub: Stub): boolean {
		return false;
	}
	/** The mouse moved over `model` at (x, y), or off every diagram of this kind (null). */
	protected hoverAt(_model: M | null, _target: Element | null, _x: number, _y: number): void {}
	/** A right click on the diagram: true when the subclass showed a menu. */
	protected contextMenu(_e: MouseEvent, _model: M): boolean {
		return false;
	}
	/** A stub started waiting for its handle to be dragged (or a node to be pressed). */
	protected stubWaits(): void {}
	/** A press outside every diagram of this kind. */
	protected pressOutside(_e: PointerEvent): void {}
	/** Escape, unload: drop whatever the subclass keeps armed. */
	protected disarm(): void {}
	/** Whether the subclass keeps something armed (a legend action, a mode). */
	protected isArmed(): boolean {
		return false;
	}

	// ---- event handlers (registered by main.ts in the capture phase) ----------------------

	onPointerDown = (e: PointerEvent) => {
		if (!this.enabled() || this.active || e.button !== 0 || !e.isPrimary) return;
		this.touchSeen = e.pointerType !== 'mouse';
		const stub = this.stub;
		if (stub && this.onStubEnd(stub, e)) return this.start(e, this.stubDrag(e, stub), stub.model.svg);
		if (stub && stub.line.isConnected && this.stubPress(e, stub)) {
			this.stub = null;
			return;
		}
		if (stub) this.dropStub();

		if (Legend.onMenu(e.target)) {
			const svg = diagramIn(e.target, this.kind);
			if (!svg) return;  // another editor's menu
			this.claim(e);
			const model = this.modelOf(svg);
			if (!model) return void this.fail(`This ${this.names.noun} was drawn by an earlier plugin load and is redrawn now, please try again.`);
			if (this.tellBlocked(model)) return;
			const box = svg.closest<HTMLElement>('.mermaid')!;
			// The button: a finger has no hover, a tap opens and closes; a click keeps it open.
			if (Legend.onButton(e.target)) return void (this.touchSeen ? this.legend.toggle(box) : this.legend.show(box));
			const kind = Legend.itemAt(e.target);
			if (kind) {
				this.legend.hide();
				this.legendAction(model, kind, (e.target as Element).closest('[data-mp-add]')!);
			}
			return;
		}
		// A press anywhere else closes an open legend (a finger's in particular: it has no hover to leave).
		this.legend.hide();
		const svg = diagramOf(e.target, this.kind);
		if (!svg) return void this.pressOutside(e);
		const model = this.modelOf(svg);
		if (!model) {
			// Drawn by an earlier plugin load, or a tag forged in the note's HTML: one notice and
			// redraw per 10 s at most, so a forged tag cannot keep every open note redrawing (F5).
			this.claim(e);
			if (Date.now() - this.staleAt < 10_000) return;
			this.staleAt = Date.now();
			return void this.fail(`This ${this.names.noun} was drawn by an earlier plugin load and is redrawn now, please try again.`);
		}
		// The press is left to Obsidian (in Live Preview it opens the source).
		if (this.tellBlocked(model)) return;
		this.press(e, model);
	};

	onPointerMove = (e: PointerEvent) => {
		const g = this.active;
		if (g && e.pointerId === g.pointerId) {
			this.claim(e);
			return g.move(e);
		}
		if (g || e.pointerType !== 'mouse') return;
		// With the legend open the pointer is on it: no hover marks beside the elements under it.
		if (this.updateLegend(e)) return this.hoverAt(null, null, 0, 0);
		this.hoverCursor(e);
	};

	/** A right click on an editable diagram: the subclass's menu instead of Obsidian's. */
	onContextMenu = (e: MouseEvent) => {
		if (!this.enabled()) return;
		const svg = diagramOf(e.target, this.kind);
		const model = svg ? this.modelOf(svg) : null;
		if (!model || this.blockedReason(model)) return;
		if (this.contextMenu(e, model)) this.claim(e);
	};

	onPointerUp = (e: PointerEvent) => {
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		this.claim(e);
		this.end(g, e);
		try {
			const waiting = g.up(e);
			if (waiting) { this.stub = waiting; this.stubWaits(); }
			else if (this.stub && g instanceof NewLinkDrag) this.stub = null;
		} catch (err) {
			this.report(err);
		}
	};

	onPointerCancel = (e: PointerEvent) => {
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		this.end(g, e);
		g.cancel();
		if (g instanceof NewLinkDrag) this.stub = null;
	};

	/** Swallows the mouse events that would otherwise open the block's source in Live Preview. */
	onSwallow = (e: Event) => {
		if (!this.enabled() || !isElement(e.target)) return;
		const recent = this.swallow && Date.now() < this.swallow.until && this.swallow.box.contains(e.target);
		const svg = diagramOf(e.target, this.kind);
		const model = svg ? this.modelOf(svg) : null;
		const onElement = model && this.claims(model, e.target, (e as MouseEvent).clientX, (e as MouseEvent).clientY, false);
		if (recent || onElement || (Legend.onMenu(e.target) && diagramIn(e.target, this.kind))) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	/** The system's double click (follows OS timing; the target is the diagram after pointer capture). */
	onDblClick = (e: MouseEvent) => {
		const box = this.tapBox;
		const mine = this.enabled() && box && isElement(e.target) && box.contains(e.target);
		const t = mine ? this.taps.take(DBLCLICK_MS) : null;
		if (t) {
			e.preventDefault();
			e.stopPropagation();
			t.open();
			return;
		}
		this.onSwallow(e);
	};

	/**
	 * A touch that starts on something editable must not become a scroll, or the browser
	 * cancels the pointer stream. CSS `touch-action` is ignored inside an SVG, so this is done
	 * per gesture with the same classification as a press; the rest of the diagram still scrolls.
	 */
	onTouchStart = (e: TouchEvent) => {
		if (!this.enabled()) return;
		const t = e.touches[0];
		if (Legend.onMenu(e.target) && diagramIn(e.target, this.kind)) return void e.preventDefault();
		const svg = diagramOf(e.target, this.kind);
		const model = svg ? this.modelOf(svg) : null;
		if (!t || !model) return;
		if ((this.stub && this.onStubEnd(this.stub, t)) || this.claims(model, e.target as Element, t.clientX, t.clientY, true)) e.preventDefault();
	};

	onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'Escape') return;
		this.release();
	};

	/**
	 * Whether something waits for the next press or key: a gesture, a stub, an open legend, an armed
	 * action. The zoom's Escape leaves such a state to the editor first and closes only afterwards.
	 */
	busy(): boolean {
		return !!this.active || !!this.stub?.line.isConnected || this.legend.isShown() || this.isArmed();
	}

	/** Drops whatever waits (Escape; the zoom opening or closing: a stub or an armed action must not cross between note and zoom). */
	release() {
		this.dropStub();
		this.disarm();
		this.legend.hide();
	}

	/** Undoes every trace of the editor in each of `docs`, the app's windows (plugin unload, review finding #6). */
	destroy(docs: Iterable<Document>) {
		this.active?.cancel();
		this.active = null;
		this.dropStub();
		this.disarm();
		this.taps.clear();
		this.legend.destroy(docs);
		this.hoverAt(null, null, 0, 0);
		for (const m of Array.from(this.modals)) m.close();
		for (const doc of docs) {
			doc.querySelectorAll<SVGSVGElement>(`svg[${KEY_ATTR}][${KIND_ATTR}="${this.kind}"]`).forEach(svg => { svg.style.cursor = ''; });
			doc.querySelectorAll('.mp-drop-target, .mp-dragging, .mp-leaving, .mp-flash, .mp-group-editing').forEach(el => el.classList.remove('mp-drop-target', 'mp-dragging', 'mp-leaving', 'mp-flash', 'mp-group-editing'));
			doc.querySelectorAll('.mp-drag-hint, .mp-plus-handle').forEach(el => el.remove());
		}
	}

	// ---- EditCtx -----------------------------------------------------------------------------

	/** Computes the new source, validates it with Mermaid, and writes it into the note. */
	async apply(model: M, edit: (src: string) => string): Promise<boolean> {
		return (await this.write(model, edit)) !== null;
	}

	/**
	 * `apply`, answering what was written: the view, the source before and after (for undo, and
	 * for finding the redrawn diagram), or null when nothing was. `src` is the block as the note
	 * holds it now: the drawing's source unless an edit was written before the redraw.
	 */
	protected async write(model: M, edit: (src: string) => string, src = model.src): Promise<{ view: MarkdownView; src: string; next: string } | null> {
		try {
			const view = viewOf(this.app, model.svg);
			if (!view?.file) return this.fail(`Open the note itself to edit this ${this.names.noun}.`), null;
			let next: string;
			try {
				next = edit(src);
			} catch (e) {
				return this.fail(e instanceof EditError ? e.message : String(e)), null;
			}
			if (next === src) { this.rerender(); return null; }
			try {
				await this.mermaid()?.parse(next);
			} catch (e) {
				return this.fail(`The edit would break the ${this.names.noun}, nothing was changed. ${e instanceof Error ? e.message : ''}`), null;
			}
			const refused = await writeBlock(this.app, view, src, next);
			return refused ? (this.fail(refused), null) : { view, src, next };
		} catch (e) {
			// e.g. the note was renamed or deleted mid-edit (review finding #8)
			this.report(e);
			return null;
		}
	}

	/** A confirmation: shown as a Notice and kept in the log (a Notice is gone after seconds). */
	info(message: string) {
		new Notice(`${this.names.title}: ${capital(message)}`);
		console.info(`[mermaid-direct-edit] ${message}`);
	}

	tap(key: unknown, model: M, open: () => void) {
		this.tapBox = model.svg.closest('.mermaid') ?? model.svg;
		this.taps.tap(key, open);
	}

	// ---- for subclasses ----------------------------------------------------------------------

	/** Opens a dialog and keeps track of it, so unload can close it. */
	protected open(modal: Modal) {
		this.modals.add(modal);
		const onClose = modal.onClose.bind(modal);
		modal.onClose = () => { this.modals.delete(modal); onClose(); };
		modal.open();
	}

	/** Makes `gesture` the active one and captures the pointer on the diagram. */
	protected start(e: PointerEvent, gesture: Gesture, svg: SVGSVGElement) {
		this.claim(e);
		try { svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
		this.active = gesture;
	}

	protected claim(e: Event) {
		e.preventDefault();
		e.stopPropagation();
	}

	/** Swallows the click that follows a press handled without a gesture (an armed legend action). */
	protected swallowAfter(svg: SVGSVGElement) {
		this.swallow = { until: Date.now() + 500, box: svg.closest('.mermaid') ?? svg };
	}

	/**
	 * Runs `edit` and confirms with `message` once it is written, with an Undo button: reading view
	 * and phones have no Cmd+Z, and a structural edit (delete, re-link, a new group) is the kind
	 * worth taking back. Undo writes the old source back if the block is still the new one.
	 */
	protected applyThen(model: M, edit: (src: string) => string, message: string, src = model.src): Promise<{ view: MarkdownView; next: string } | null> {
		return this.write(model, edit, src).then(done => {
			if (done) this.undoable(message, done.view, done.src, done.next);
			return done;
		});
	}

	private undoable(message: string, view: MarkdownView, src: string, next: string) {
		console.info(`[mermaid-direct-edit] ${message}`);
		const file = view.file;
		const frag = createFragment(f => {
			f.createSpan({ text: `${this.names.title}: ${capital(message)} ` });
			const b = f.createEl('button', { text: 'Undo', cls: 'mp-undo' });
			b.addEventListener('click', ev => {
				ev.stopPropagation();
				notice.hide();
				// The tab may show another note by now (security review 0.18.0): undo only in the same one.
				if (view.file !== file) return void this.fail('The note in that tab changed, nothing was undone.');
				void writeBlock(this.app, view, next, src).then(refused => {
					if (refused) this.fail(refused);
					else this.info('undone.');
				});
			});
		});
		const notice = new Notice(frag, 8000);
	}

	/** Reports a refused edit; the redraw puts a dragged element back where the source has it. */
	protected fail(message: string): false {
		new Notice(`${this.names.title}: ${message}`);
		console.warn(`[mermaid-direct-edit] ${message}`);
		this.rerender();
		return false;
	}

	protected report(e: unknown) {
		console.error('[mermaid-direct-edit] edit failed:', e);
		this.fail(`The edit failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	protected rerender() {
		this.app.workspace.trigger('post-processor-change');
	}

	protected dropStub() {
		this.stub?.remove();
		this.stub = null;
	}

	protected onStubEnd(stub: Stub, p: { clientX: number; clientY: number }): boolean {
		if (!stub.line.isConnected) return false;
		const end = stub.end();
		return Math.hypot(end.x - p.clientX, end.y - p.clientY) <= STUB_GRAB;
	}

	// ---- internals ---------------------------------------------------------------------------

	private end(g: Gesture, e: PointerEvent) {
		this.active = null;
		this.swallowAfter(g.model.svg);
		try { if (g.model.svg.hasPointerCapture(e.pointerId)) g.model.svg.releasePointerCapture(e.pointerId); } catch { /* detached */ }
	}

	/** Mouse hover: on a menu (button or legend) of this editor's kind its legend opens; anywhere else an open one closes soon. True while on the menu. */
	private updateLegend(e: PointerEvent): boolean {
		const target = isElement(e.target) ? e.target : null;
		const svg = this.enabled() && Legend.onMenu(target) ? diagramIn(target, this.kind) : null;
		const model = svg ? this.modelOf(svg) : null;
		if (model && !this.blockedReason(model)) {
			this.legend.show(model.svg.closest<HTMLElement>('.mermaid')!);
			return true;
		}
		this.legend.leave();
		return false;
	}

	/** Why this drawing is not editable, told once per drawing; true when it is not. */
	private tellBlocked(model: M): boolean {
		const blocked = this.blockedReason(model);
		if (!blocked) return false;
		if (!this.toldBlocked.has(model.svg)) {
			this.toldBlocked.add(model.svg);
			this.info(`not editable here: ${blocked} Edit it in the source.`);
		}
		return true;
	}

	/** Mouse hover: the cursor tells what a press would do (same classification as a press). */
	private hoverCursor(e: PointerEvent) {
		const svg = this.enabled() ? diagramOf(e.target, this.kind) : null;
		const model = svg ? this.modelOf(svg) : null;
		if (!svg || !model || this.blockedReason(model)) return this.hoverAt(null, null, 0, 0);
		this.hoverAt(model, e.target as Element, e.clientX, e.clientY);
		if (this.stub && this.onStubEnd(this.stub, e)) {
			svg.style.cursor = 'grab';
			return;
		}
		svg.style.cursor = this.cursorAt(model, e.target as Element, e.clientX, e.clientY);
	}
}

/** A message as a sentence after the editor's name. */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
