import { DRAG_THRESHOLD, LONG_PRESS_MS, Pt } from './geometry';

/** A rendered diagram an editor works on: its SVG, the source it was drawn from, the projection. */
export interface Surface {
	readonly svg: SVGSVGElement;
	readonly src: string;
	/** Screen pixels to SVG units (the CTM changes with scrolling, so it is read each time). */
	toSvg(clientX: number, clientY: number): Pt;
	/** SVG units to screen pixels. */
	toScreen(x: number, y: number): Pt;
}

/** What every gesture may ask its editor to do. */
export interface EditCtx<M extends Surface> {
	/** Computes, validates and writes an edit of the diagram's source; true when written. */
	apply(model: M, edit: (src: string) => string): Promise<boolean>;
	info(message: string): void;
	/** A tap; a second one on the same key soon after opens `open` (double tap / click). */
	tap(key: unknown, model: M, open: () => void): void;
}

/** One pointer interaction from press to release, owned by the editor's single `active` slot. */
export interface Gesture {
	readonly model: Surface;
	readonly pointerId: number;
	move(e: PointerEvent): void;
	/** Release. A new-link drag dropped on nothing may return its stub, which waits to be dragged on. */
	up(e: PointerEvent): Stub | void;
	/** Abort (pointercancel, a second plugin load): restore what the drag changed on screen. */
	cancel(): void;
}

/** Shared drag mechanics: the threshold that separates a tap from a drag, and the offset. */
export abstract class DragGesture<M extends Surface, C = EditCtx<M>> implements Gesture {
	readonly pointerId: number;
	protected moved = false;
	private readonly startClient: Pt;
	protected readonly start: Pt;

	constructor(readonly model: M, e: PointerEvent, protected ctx: C, private axis: 'xy' | 'x' = 'xy') {
		this.pointerId = e.pointerId;
		this.startClient = { x: e.clientX, y: e.clientY };
		this.start = model.toSvg(e.clientX, e.clientY);
	}

	/** The pointer's offset from the press, in SVG units. */
	protected offset(e: PointerEvent): Pt {
		const p = this.model.toSvg(e.clientX, e.clientY);
		return { x: p.x - this.start.x, y: this.axis === 'x' ? 0 : p.y - this.start.y };
	}

	move(e: PointerEvent) {
		if (!this.moved) {
			const dx = e.clientX - this.startClient.x, dy = this.axis === 'x' ? 0 : e.clientY - this.startClient.y;
			if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
			this.moved = true;
		}
		this.drag(this.offset(e), e);
	}

	up(e: PointerEvent): Stub | void {
		if (!this.moved) return this.tap();
		return this.drop(this.offset(e), e);
	}

	cancel() {
		this.restore();
	}

	protected abstract drag(d: Pt, e: PointerEvent): void;
	protected abstract drop(d: Pt, e: PointerEvent): Stub | void;
	protected abstract restore(): void;
	protected tap(): Stub | void {}
}

export const translate = (el: Element, d: Pt) => el.setAttribute('transform', `translate(${d.x} ${d.y})`);

/** Highlights the element a dragged end would be dropped on. */
export class DropHighlight {
	el: Element | null = null;

	set(next: Element | null) {
		if (next === this.el) return;
		this.el?.classList.remove('mp-drop-target');
		next?.classList.add('mp-drop-target');
		this.el = next;
	}
}

/**
 * A provisional link from the element `from`, drawn only in the SVG: nothing is written until its
 * free end is dropped (on another element, or on empty space where the editor creates one). The
 * free end carries a round handle, so it reads as something to grab, not as a dashed link.
 */
export class Stub {
	constructor(readonly model: Surface, readonly line: SVGLineElement, readonly handle: SVGCircleElement, readonly from: string) {}

	/** Draws a stub from `center` towards `toward` (SVG units), `length` long, into `parent`. */
	static draw(model: Surface, from: string, center: Pt, toward: Pt, length: number, parent: Element): Stub {
		const dx = toward.x - center.x, dy = toward.y - center.y;
		const len = Math.hypot(dx, dy) || 1;
		const ns = 'http://www.w3.org/2000/svg';
		const line = model.svg.ownerDocument.createElementNS(ns, 'line');
		line.setAttribute('class', 'mp-new-link');
		line.setAttribute('x1', String(center.x));
		line.setAttribute('y1', String(center.y));
		const handle = model.svg.ownerDocument.createElementNS(ns, 'circle');
		handle.setAttribute('class', 'mp-new-link-end');
		handle.setAttribute('r', '4');
		parent.appendChild(line);
		parent.appendChild(handle);
		const stub = new Stub(model, line, handle, from);
		stub.moveEnd({ x: center.x + dx / len * length, y: center.y + dy / len * length });
		return stub;
	}

	/** Puts the free end at `p` (SVG units). */
	moveEnd(p: Pt) {
		this.line.setAttribute('x2', String(p.x));
		this.line.setAttribute('y2', String(p.y));
		this.handle.setAttribute('cx', String(p.x));
		this.handle.setAttribute('cy', String(p.y));
	}

	/** The free end in screen pixels. */
	end(): Pt {
		return this.model.toScreen(Number(this.line.getAttribute('x2')), Number(this.line.getAttribute('y2')));
	}

	remove() {
		this.line.remove();
		this.handle.remove();
	}
}

/** Where a new link can end: the element's id in the source and the element to highlight. */
export interface LinkTarget { id: string; el: Element }

export interface NewLinkOptions {
	/** The element under the pointer that would accept the link, if any. */
	targetAt(e: PointerEvent): LinkTarget | null;
	/** Dropped on `to`: write the link. */
	link(from: string, to: string): void;
	/** Dropped on empty space at `at` (SVG units): create a new element there, linked from `from`. */
	empty(from: string, at: Pt): void;
}

/**
 * Drags a stub's free end, which follows the pointer. Dropped on an element it links to it;
 * dropped on empty space it asks the editor for a new element right there (decision 2026-10-11,
 * the same in every diagram type). A tap without moving, or a drop back on its own element,
 * leaves the stub waiting.
 */
export class NewLinkDrag implements Gesture {
	readonly pointerId: number;
	readonly model: Surface;
	private readonly startClient: Pt;
	private moved = false;
	private readonly highlight = new DropHighlight();
	private target: LinkTarget | null = null;
	private onOrigin = false;

	constructor(e: PointerEvent, private stub: Stub, private o: NewLinkOptions) {
		this.pointerId = e.pointerId;
		this.model = stub.model;
		this.startClient = { x: e.clientX, y: e.clientY };
	}

	move(e: PointerEvent) {
		if (!this.moved && Math.hypot(e.clientX - this.startClient.x, e.clientY - this.startClient.y) < DRAG_THRESHOLD) return;
		this.moved = true;
		this.stub.moveEnd(this.model.toSvg(e.clientX, e.clientY));
		const t = this.o.targetAt(e);
		this.onOrigin = t?.id === this.stub.from;
		this.target = t && !this.onOrigin ? t : null;
		this.highlight.set(this.target?.el ?? null);
	}

	up(e: PointerEvent): Stub | void {
		if (!this.moved) return this.stub;  // a click in the "+" ring: the stub waits to be dragged
		this.move(e);
		const target = this.target;
		this.highlight.set(null);
		if (this.onOrigin) return this.stub;  // dropped back where it started: nothing to create
		this.stub.remove();
		const from = this.stub.from;
		if (target) return this.o.link(from, target.id);
		this.o.empty(from, this.model.toSvg(e.clientX, e.clientY));
	}

	cancel() {
		this.highlight.set(null);
		this.stub.remove();
	}
}

/** A press that acts on release without moving: a link's middle opens its dialog. */
export class TapPress implements Gesture {
	readonly pointerId: number;
	private readonly startClient: Pt;
	private moved = false;

	constructor(readonly model: Surface, e: PointerEvent, private onTap: () => void) {
		this.pointerId = e.pointerId;
		this.startClient = { x: e.clientX, y: e.clientY };
	}

	move(e: PointerEvent) {
		if (Math.hypot(e.clientX - this.startClient.x, e.clientY - this.startClient.y) >= DRAG_THRESHOLD) this.moved = true;
	}

	up() {
		if (!this.moved) this.onTap();
	}

	cancel() {}
}

/**
 * A press that deletes (an evolve arrow's shaft): a mouse click deletes on release, touch needs
 * a long press so that scrolling past a diagram cannot delete anything. Moving cancels.
 */
export class DeletePress<M extends Surface> implements Gesture {
	readonly pointerId: number;
	private readonly startClient: Pt;
	private timer: number | null = null;
	private done = false;

	constructor(readonly model: M, e: PointerEvent, private ctx: EditCtx<M>, private edit: (src: string) => string, private message: string) {
		this.pointerId = e.pointerId;
		this.startClient = { x: e.clientX, y: e.clientY };
		if (e.pointerType !== 'mouse') this.timer = window.setTimeout(() => { this.timer = null; this.run(); }, LONG_PRESS_MS);
	}

	private run() {
		if (this.done) return;
		this.done = true;
		void this.ctx.apply(this.model, this.edit).then(ok => { if (ok) this.ctx.info(this.message); });
	}

	move(e: PointerEvent) {
		if (Math.hypot(e.clientX - this.startClient.x, e.clientY - this.startClient.y) >= DRAG_THRESHOLD) this.cancel();
	}

	up(e: PointerEvent) {
		if (e.pointerType === 'mouse') this.run();
		this.cancel();  // touch: released before the long press, or after it already ran
	}

	cancel() {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.done = true;
	}
}
