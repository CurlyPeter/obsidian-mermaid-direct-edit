import { DragGesture, DropHighlight, EditCtx, translate } from './gestures';
import { Pt, evolutionAt, trendTargetX, visibilityAt } from './wardley-geometry';
import { Hit, dropTargetAt } from './wardley-hit';
import { MapModel, MapNode } from './wardley-map';
import {
	ForceKind, getPosition, groupsOf, relink, setAnnotationPosition, setAnnotationsBoxPosition, setEvolveTarget, setForcePosition,
	setGroupLabel, setInertiaPosition, setLabelOffset, setNotePosition, setPosition, shiftPipeline,
} from './wardley-text';

/** What a Wardley gesture may ask the editor to do, beyond writing an edit. */
export interface GestureCtx extends EditCtx<MapModel> {
	openNodeDialog(model: MapModel, node: MapNode): void;
	openForceDialog(model: MapModel, kind: ForceKind, name: string): void;
	openAnnotationDialog(model: MapModel, number: number): void;
}

/** The Wardley gestures' base: shared drag mechanics plus the map's plot box. */
abstract class MapDrag extends DragGesture<MapModel, GestureCtx> {
	protected get box() {
		return this.model.box;
	}
}

/** Moves an anchor or component (with its links, or a whole pipeline), or only its label. */
export class NodeDrag extends MapDrag {
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
export class ForceDrag extends MapDrag {
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

/**
 * Moves an annotation's numbered circle (`annotation N,[v, e]`) or the box listing the texts
 * (`annotations [v, e]`, its top left corner). The box is written where it is drawn: Mermaid
 * keeps it inside the map, so the declared corner may lie outside. A double tap on a circle or
 * on a line of the box opens that annotation's dialog.
 */
export class AnnotationDrag extends MapDrag {
	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private hit: Extract<Hit, { kind: 'annotation' }>) {
		super(model, e, ctx);
	}

	protected drag(d: Pt) {
		translate(this.hit.part, d);
	}

	protected drop(d: Pt) {
		const { box, number, origin } = this.hit;
		const v = visibilityAt(this.box, origin.y + d.y), ev = evolutionAt(this.box, origin.x + d.x);
		if (box) void this.ctx.apply(this.model, src => setAnnotationsBoxPosition(src, v, ev));
		else if (number !== null) void this.ctx.apply(this.model, src => setAnnotationPosition(src, number, v, ev));
	}

	protected tap() {
		const n = this.hit.number;
		if (n !== null) this.ctx.tap(`annotation:${n}`, this.model, () => this.ctx.openAnnotationDialog(this.model, n));
	}

	protected restore() {
		this.hit.part.removeAttribute('transform');
	}
}

/** Moves an inertia bar along its component's evolution axis (plugin extension `%% mp-inertia`). */
export class InertiaDrag extends MapDrag {
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

/**
 * Moves a group's label. The plugin places it above the boundary; what the drag adds goes after
 * the group's name as `label [dx, dy]`, so the label keeps its place relative to the group.
 */
export class GroupLabelDrag extends MapDrag {
	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private el: SVGTextElement, private name: string) {
		super(model, e, ctx);
	}

	protected drag(d: Pt) {
		translate(this.el, d);
	}

	protected drop(d: Pt) {
		const name = this.name;
		void this.ctx.apply(this.model, src => {
			const [dx, dy] = groupsOf(src).find(g => g.name === name)?.label ?? [0, 0];
			return setGroupLabel(src, name, dx + d.x, dy + d.y);
		});
	}

	protected restore() {
		this.el.removeAttribute('transform');
	}
}

/** Moves a note (its text starts at its declared position). */
export class NoteDrag extends MapDrag {
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
export class TrendTipDrag extends MapDrag {
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

/** Drags one end of a link onto another node: `A -> B` becomes `A -> C`. */
export class LinkEndDrag extends MapDrag {
	private readonly orig: Pt;
	private readonly highlight = new DropHighlight();
	private target: MapNode | null = null;

	constructor(model: MapModel, e: PointerEvent, ctx: GestureCtx, private line: SVGLineElement, private end: 1 | 2, private names: [string, string]) {
		super(model, e, ctx);
		this.orig = { x: Number(line.getAttribute(`x${end}`)), y: Number(line.getAttribute(`y${end}`)) };
	}

	protected drag(d: Pt, e: PointerEvent) {
		this.line.setAttribute(`x${this.end}`, String(this.orig.x + d.x));
		this.line.setAttribute(`y${this.end}`, String(this.orig.y + d.y));
		this.target = dropTargetAt(this.model, e.clientX, e.clientY);
		this.highlight.set(this.target?.node ?? null);
	}

	protected drop() {
		const target = this.target;
		this.highlight.set(null);
		const oldEnd = this.names[this.end - 1];
		if (!target || target.name === oldEnd) return this.restore();
		const [a, b] = this.names, to = target.name;
		void this.ctx.apply(this.model, src => relink(src, a, b, oldEnd, to));
	}

	protected restore() {
		this.highlight.set(null);
		this.line.setAttribute(`x${this.end}`, String(this.orig.x));
		this.line.setAttribute(`y${this.end}`, String(this.orig.y));
	}
}
