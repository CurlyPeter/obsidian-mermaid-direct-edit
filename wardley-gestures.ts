import { DRAG_THRESHOLD, LONG_PRESS_MS, Pt, evolutionAt, trendTargetX, visibilityAt } from './wardley-geometry';
import { dropTargetAt } from './wardley-hit';
import { MapModel, MapNode } from './wardley-map';
import {
	ForceKind, addLink, getPosition, relink, setEvolveTarget, setForcePosition, setInertiaPosition, setLabelOffset,
	setNotePosition, setPosition, shiftPipeline,
} from './wardley-text';

/** What a gesture may ask the editor to do. */
export interface GestureCtx {
	/** Computes, validates and writes an edit of the map's source; true when written. */
	apply(model: MapModel, edit: (src: string) => string): Promise<boolean>;
	info(message: string): void;
	/** A tap; a second one on the same key soon after opens `open` (double tap / click). */
	tap(key: unknown, model: MapModel, open: () => void): void;
	openNodeDialog(model: MapModel, node: MapNode): void;
	openForceDialog(model: MapModel, kind: ForceKind, name: string): void;
}

/** One pointer interaction from press to release, owned by the editor's single `active` slot. */
export interface Gesture {
	readonly model: MapModel;
	readonly pointerId: number;
	move(e: PointerEvent): void;
	/** Release. A new-link drag dropped on nothing returns its stub, which waits to be dragged on. */
	up(e: PointerEvent): Stub | void;
	/** Abort (pointercancel, a second plugin load): restore what the drag changed on screen. */
	cancel(): void;
}

/** Shared drag mechanics: the threshold that separates a tap from a drag, and the offset. */
abstract class DragGesture implements Gesture {
	readonly pointerId: number;
	protected moved = false;
	private readonly startClient: Pt;
	protected readonly start: Pt;

	constructor(readonly model: MapModel, e: PointerEvent, protected ctx: GestureCtx, private axis: 'xy' | 'x' = 'xy') {
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
		return this.drop(this.offset(e));
	}

	cancel() {
		this.restore();
	}

	protected abstract drag(d: Pt, e: PointerEvent): void;
	protected abstract drop(d: Pt): Stub | void;
	protected abstract restore(): void;
	protected tap(): Stub | void {}

	protected get box() {
		return this.model.box;
	}
}

const translate = (el: Element, d: Pt) => el.setAttribute('transform', `translate(${d.x} ${d.y})`);

/** Moves an anchor or component (with its links, or a whole pipeline), or only its label. */
export class NodeDrag extends DragGesture {
	private readonly links: ReturnType<MapModel['linksAt']>;
	private readonly extra: Element[];
	private readonly pipeline: boolean;

	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private node: MapNode, private label: SVGTextElement | null) {
		super(model, e, ctx);
		this.links = label ? [] : model.linksAt(node.center);
		const parts = label ? null : model.pipelineParts(node.name);
		this.extra = parts ?? [];
		this.pipeline = parts !== null;
	}

	protected drag(d: Pt) {
		this.node.node.classList.add('mp-dragging');
		if (this.label) return translate(this.label, d);
		translate(this.node.node, d);
		for (const el of this.extra) translate(el, d);
		for (const l of this.links) {
			l.el.setAttribute(`x${l.end}`, String(l.orig.x + d.x));
			l.el.setAttribute(`y${l.end}`, String(l.orig.y + d.y));
		}
	}

	protected drop(d: Pt) {
		const { name, center } = this.node;
		if (this.label) {
			// New offset = where the label now sits, relative to the component's centre.
			const lx = Number(this.label.getAttribute('x')) + d.x, ly = Number(this.label.getAttribute('y')) + d.y;
			void this.ctx.apply(this.model, src => setLabelOffset(src, name, lx - center.x, ly - center.y));
			return;
		}
		// Deltas on the declared position: a pipeline parent is drawn above its box, not where
		// it is declared, so an absolute position read from the drawing would be off.
		const dEvo = d.x / (this.box.right - this.box.left);
		const dVis = -d.y / (this.box.bottom - this.box.top);
		const pipeline = this.pipeline;
		void this.ctx.apply(this.model, src => {
			const pos = getPosition(src, name);
			const moved = setPosition(src, name, (pos.visibility ?? 0) + dVis, pos.evolution + dEvo);
			return pipeline ? shiftPipeline(moved, name, dEvo) : moved;
		});
	}

	protected tap() {
		this.ctx.tap(this.node.node, this.model, () => this.ctx.openNodeDialog(this.model, this.node));
	}

	protected restore() {
		this.label?.removeAttribute('transform');
		this.node.node.removeAttribute('transform');
		this.node.node.classList.remove('mp-dragging');
		for (const el of this.extra) el.removeAttribute('transform');
		for (const l of this.links) {
			l.el.setAttribute(`x${l.end}`, String(l.orig.x));
			l.el.setAttribute(`y${l.end}`, String(l.orig.y));
		}
	}
}

/** Moves an accelerator or deaccelerator as a whole; a double tap opens its dialog. */
export class ForceDrag extends DragGesture {
	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private kind: ForceKind, private name: string, private parts: Element[], private origin: Pt) {
		super(model, e, ctx);
	}

	protected drag(d: Pt) {
		for (const el of this.parts) translate(el, d);
	}

	protected drop(d: Pt) {
		const { kind, name } = this;
		const v = visibilityAt(this.box, this.origin.y + d.y), ev = evolutionAt(this.box, this.origin.x + d.x);
		void this.ctx.apply(this.model, src => setForcePosition(src, kind, name, v, ev));
	}

	protected tap() {
		this.ctx.tap(`${this.kind}:${this.name}`, this.model, () => this.ctx.openForceDialog(this.model, this.kind, this.name));
	}

	protected restore() {
		for (const el of this.parts) el.removeAttribute('transform');
	}
}

/** Moves an inertia bar along its component's evolution axis (plugin extension `%% mp-inertia`). */
export class InertiaDrag extends DragGesture {
	private readonly x: number;

	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private bar: SVGLineElement, private name: string) {
		super(model, e, ctx, 'x');
		this.x = Number(bar.getAttribute('x1'));
	}

	protected drag(d: Pt) {
		this.bar.setAttribute('x1', String(this.x + d.x));
		this.bar.setAttribute('x2', String(this.x + d.x));
	}

	protected drop(d: Pt) {
		const name = this.name, ev = evolutionAt(this.box, this.x + d.x);
		void this.ctx.apply(this.model, src => setInertiaPosition(src, name, ev));
	}

	protected restore() {
		this.bar.setAttribute('x1', String(this.x));
		this.bar.setAttribute('x2', String(this.x));
	}
}

/** Moves a note (its text starts at its declared position). */
export class NoteDrag extends DragGesture {
	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private el: SVGTextElement, private text: string) {
		super(model, e, ctx);
	}

	protected drag(d: Pt) {
		translate(this.el, d);
	}

	protected drop(d: Pt) {
		const text = this.text;
		const v = visibilityAt(this.box, Number(this.el.getAttribute('y')) + d.y);
		const ev = evolutionAt(this.box, Number(this.el.getAttribute('x')) + d.x);
		void this.ctx.apply(this.model, src => setNotePosition(src, text, v, ev));
	}

	protected restore() {
		this.el.removeAttribute('transform');
	}
}

/** Lengthens or shortens an evolve arrow at its tip (horizontal only). */
export class TrendTipDrag extends DragGesture {
	private readonly tipX: number;

	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private line: SVGLineElement, private name: string) {
		super(model, e, ctx, 'x');
		this.tipX = Number(line.getAttribute('x2'));
	}

	protected drag(d: Pt) {
		this.line.setAttribute('x2', String(this.tipX + d.x));
	}

	protected drop(d: Pt) {
		const name = this.name;
		const targetX = trendTargetX(this.tipX + d.x, Number(this.line.getAttribute('x1')), this.model.nodeRadius);
		const ev = evolutionAt(this.box, targetX);
		void this.ctx.apply(this.model, src => setEvolveTarget(src, name, ev));
	}

	protected restore() {
		this.line.setAttribute('x2', String(this.tipX));
	}
}

/** Highlights the node a dragged link end would be dropped on. */
class DropHighlight {
	node: MapNode | null = null;

	set(next: MapNode | null) {
		if (next?.node === this.node?.node) return;
		this.node?.node.classList.remove('mp-drop-target');
		next?.node.classList.add('mp-drop-target');
		this.node = next;
	}
}

/** Drags one end of a link onto another node: `A -> B` becomes `A -> C`. */
export class LinkEndDrag extends DragGesture {
	private readonly orig: Pt;
	private readonly drop_ = new DropHighlight();

	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private line: SVGLineElement, private end: 1 | 2, private names: [string, string]) {
		super(model, e, ctx);
		this.orig = { x: Number(line.getAttribute(`x${end}`)), y: Number(line.getAttribute(`y${end}`)) };
	}

	protected drag(d: Pt, e: PointerEvent) {
		this.line.setAttribute(`x${this.end}`, String(this.orig.x + d.x));
		this.line.setAttribute(`y${this.end}`, String(this.orig.y + d.y));
		this.drop_.set(dropTargetAt(this.model, e.clientX, e.clientY));
	}

	protected drop() {
		const target = this.drop_.node;
		this.drop_.set(null);
		const oldEnd = this.names[this.end - 1];
		if (!target || target.name === oldEnd) return this.restore();
		const [a, b] = this.names, to = target.name;
		void this.ctx.apply(this.model, src => relink(src, a, b, oldEnd, to));
	}

	protected restore() {
		this.drop_.set(null);
		this.line.setAttribute(`x${this.end}`, String(this.orig.x));
		this.line.setAttribute(`y${this.end}`, String(this.orig.y));
	}
}

/**
 * A provisional link from `from`, drawn only in the SVG: wardley-beta has no link with a single
 * end, so nothing is written until the free end is dropped on another node.
 */
export class Stub {
	constructor(readonly model: MapModel, readonly line: SVGLineElement, readonly from: string) {}

	/** Draws a stub from `node` towards the pressed point, `length` map px long. */
	static draw(model: MapModel, node: MapNode, toward: Pt, length: number): Stub {
		const dx = toward.x - node.center.x, dy = toward.y - node.center.y;
		const len = Math.hypot(dx, dy) || 1;
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('class', 'mp-new-link');
		line.setAttribute('x1', String(node.center.x));
		line.setAttribute('y1', String(node.center.y));
		line.setAttribute('x2', String(node.center.x + dx / len * length));
		line.setAttribute('y2', String(node.center.y + dy / len * length));
		(model.svg.querySelector('g.wardley-links') ?? model.svg).appendChild(line);
		return new Stub(model, line, node.name);
	}

	/** The free end in screen pixels. */
	end(): Pt {
		return this.model.toScreen(Number(this.line.getAttribute('x2')), Number(this.line.getAttribute('y2')));
	}

	remove() {
		this.line.remove();
	}
}

/** Drags a stub's free end; dropped on a node it writes `from -> to`, else the stub waits. */
export class NewLinkDrag extends DragGesture {
	private readonly end0: Pt;
	private readonly drop_ = new DropHighlight();

	constructor(e: PointerEvent, ctx: GestureCtx, private stub: Stub) {
		super(stub.model, e, ctx);
		this.end0 = { x: Number(stub.line.getAttribute('x2')), y: Number(stub.line.getAttribute('y2')) };
	}

	protected drag(d: Pt, e: PointerEvent) {
		this.stub.line.setAttribute('x2', String(this.end0.x + d.x));
		this.stub.line.setAttribute('y2', String(this.end0.y + d.y));
		const t = dropTargetAt(this.model, e.clientX, e.clientY);
		this.drop_.set(t && t.name !== this.stub.from ? t : null);
	}

	protected drop(): Stub | void {
		const target = this.drop_.node;
		this.drop_.set(null);
		if (!target) return this.stub;  // no target: the stub waits where it is
		this.stub.remove();
		const from = this.stub.from, to = target.name;
		void this.ctx.apply(this.model, src => addLink(src, from, to));
	}

	protected tap(): Stub {
		return this.stub;  // a click in the "+" ring: the stub waits to be dragged
	}

	protected restore() {
		this.drop_.set(null);
		this.stub.remove();
	}
}

/** A press that acts on release without moving: a link's middle opens its dialog. */
export class TapPress implements Gesture {
	readonly pointerId: number;
	private readonly startClient: Pt;
	private moved = false;

	constructor(readonly model: MapModel, e: PointerEvent, private onTap: () => void) {
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
 * a long press so that scrolling past a map cannot delete anything. Moving cancels.
 */
export class DeletePress implements Gesture {
	readonly pointerId: number;
	private readonly startClient: Pt;
	private timer: number | null = null;
	private done = false;

	constructor(readonly model: MapModel, e: PointerEvent, private ctx: GestureCtx, private edit: (src: string) => string, private message: string) {
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
