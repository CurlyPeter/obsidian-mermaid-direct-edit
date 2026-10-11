import { DRAG_THRESHOLD, Pt } from './geometry';
import { DragGesture, DropHighlight, EditCtx, Gesture, Stub } from './gestures';
import { FlowEdge, FlowModel, FlowNode } from './flowchart-map';

/** What a flowchart gesture may ask the editor to do, beyond writing an edit. */
export interface FlowCtx extends EditCtx<FlowModel> {
	openNodeDialog(model: FlowModel, node: FlowNode): void;
	openEdgeDialog(model: FlowModel, edge: FlowEdge): void;
	/** Moves a node into a group (null: out of every group), with an undoable notice. */
	moveNode(model: FlowModel, id: string, group: string | null): void;
	/** Re-links one end of an edge, with an undoable notice. */
	relink(model: FlowModel, edge: FlowEdge, end: 'from' | 'to', id: string): void;
}

/** The title of a group by id, for hints. */
const titleOf = (model: FlowModel, id: string | null) => (id ? model.flow?.subgraphs.find(s => s.id === id)?.title ?? id : '');

/**
 * Drags a node. A flowchart has no positions, so the only place a node can be moved to is a group
 * (subgraph): dropped on a group's box it moves in, dropped outside every group it moves out to
 * the top level. Dropped on another node or its own group it springs back. While dragging, a hint
 * at the pointer says what a drop would do and the group being left is outlined. A double tap
 * opens its dialog.
 */
export class FlowNodeDrag extends DragGesture<FlowModel, FlowCtx> {
	private static toldLayout = false;
	private readonly transform: string | null;
	private readonly highlight = new DropHighlight();
	/** The group under the pointer, `null` for the top level, undefined while over nothing new. */
	private target: string | null | undefined;
	/** The pointer is over another node. */
	private onNode = false;
	private hint: HTMLElement | null = null;

	constructor(model: FlowModel, e: PointerEvent, ctx: FlowCtx, private node: FlowNode) {
		super(model, e, ctx);
		this.transform = node.g.getAttribute('transform');
	}

	private get current(): string | null {
		return this.model.flow?.memberOf.get(this.node.id)?.id ?? null;
	}

	protected drag(d: Pt, e: PointerEvent) {
		this.node.g.classList.add('mp-dragging');
		this.node.g.setAttribute('transform', `${this.transform ?? ''} translate(${d.x} ${d.y})`.trim());
		// Over another node nothing happens: that is a try to connect, which the "+" ring does.
		this.onNode = !!this.model.nodeAt(e.clientX, e.clientY, 0, this.node);
		const over = this.onNode ? null : this.model.clusterAt(e.clientX, e.clientY);
		const target = over ? over.id : null;
		this.target = this.onNode || target === this.current ? undefined : target;
		this.highlight.set(over && this.target !== undefined ? over.g : null);
		const leaving = this.current !== null && this.target !== undefined;
		this.model.clusters.forEach(c => c.g.classList.toggle('mp-leaving', leaving && c.id === this.current));
		this.showHint(e, this.onNode ? 'To link, drag from the + beside a node'
			: this.target === undefined ? (this.current ? `Stays in "${titleOf(this.model, this.current)}"` : 'Drop on a group to move it there')
				: this.target === null ? `Out of "${titleOf(this.model, this.current)}"` : `Into "${titleOf(this.model, this.target)}"`);
	}

	protected drop() {
		const target = this.target, onNode = this.onNode, current = this.current;
		this.restore();
		if (onNode) return this.ctx.info('to link two nodes, drag from just beside a node (where the + appears) onto the other one.');
		if (target === undefined) {
			if (current === null && !FlowNodeDrag.toldLayout) {
				FlowNodeDrag.toldLayout = true;
				this.ctx.info('flowcharts are laid out automatically: drag a node onto a group to move it into that group.');
			}
			return;
		}
		this.ctx.moveNode(this.model, this.node.id, target);
	}

	protected tap() {
		this.ctx.tap(this.node.g, this.model, () => this.ctx.openNodeDialog(this.model, this.node));
	}

	protected restore() {
		this.highlight.set(null);
		this.hint?.remove();
		this.hint = null;
		this.model.clusters.forEach(c => c.g.classList.remove('mp-leaving'));
		this.node.g.classList.remove('mp-dragging');
		if (this.transform === null) this.node.g.removeAttribute('transform');
		else this.node.g.setAttribute('transform', this.transform);
	}

	/** A small label at the pointer, in the diagram's own window (pop-outs have their own). */
	private showHint(e: PointerEvent, text: string) {
		if (!this.hint) this.hint = this.model.svg.ownerDocument.body.createDiv({ cls: 'mp-drag-hint' });
		this.hint.setText(text);
		this.hint.style.left = `${e.clientX + 14}px`;
		this.hint.style.top = `${e.clientY + 14}px`;
	}
}

/**
 * Drags one end of an edge onto another node: `A --> B` becomes `A --> C`. While dragging, a
 * straight provisional line runs from the fixed end to the pointer and the edge itself is dimmed.
 * A tap opens the edge's dialog, like a tap on its middle (usability review 0.18.0: the ends were
 * dead to clicks).
 */
export class EdgeEndDrag extends DragGesture<FlowModel, FlowCtx> {
	private readonly line: SVGLineElement;
	private readonly fixed: Pt;
	private readonly highlight = new DropHighlight();
	private target: FlowNode | null = null;

	constructor(model: FlowModel, e: PointerEvent, ctx: FlowCtx, private edge: FlowEdge, private end: 'from' | 'to') {
		super(model, e, ctx);
		const other = model.edgeEnd(edge, end === 'from' ? 'to' : 'from');
		this.fixed = model.toSvg(other.x, other.y);
		this.line = model.svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
		this.line.setAttribute('class', 'mp-new-link');
	}

	protected drag(_d: Pt, e: PointerEvent) {
		if (!this.line.isConnected) {
			this.line.setAttribute('x1', String(this.fixed.x));
			this.line.setAttribute('y1', String(this.fixed.y));
			this.model.svg.appendChild(this.line);
			this.edge.path.classList.add('mp-dragging');
		}
		const p = this.model.toSvg(e.clientX, e.clientY);
		this.line.setAttribute('x2', String(p.x));
		this.line.setAttribute('y2', String(p.y));
		const n = this.model.nodeAt(e.clientX, e.clientY);
		this.target = n && n.id !== (this.end === 'from' ? this.edge.to : this.edge.from) ? n : null;
		this.highlight.set(this.target?.g ?? null);
	}

	protected drop() {
		const target = this.target;
		this.restore();
		const current = this.end === 'from' ? this.edge.from : this.edge.to;
		if (!target || target.id === current) return;
		this.ctx.relink(this.model, this.edge, this.end, target.id);
	}

	protected tap() {
		this.ctx.openEdgeDialog(this.model, this.edge);
	}

	protected restore() {
		this.highlight.set(null);
		this.line.remove();
		this.edge.path.classList.remove('mp-dragging');
	}
}

/**
 * A finger in the "+" ring: a tap leaves the stub waiting, a move gives the touch back to
 * scrolling (on touch nothing in a flowchart is dragged except a waiting stub's handle, so a swipe
 * across a diagram can never edit it; usability and code review 0.18.0).
 */
export class StubTap implements Gesture {
	readonly pointerId: number;
	readonly model: FlowModel;
	private readonly startClient: Pt;
	private moved = false;

	constructor(e: PointerEvent, private stub: Stub) {
		this.pointerId = e.pointerId;
		this.model = stub.model as FlowModel;
		this.startClient = { x: e.clientX, y: e.clientY };
	}

	move(e: PointerEvent) {
		if (!this.moved && Math.hypot(e.clientX - this.startClient.x, e.clientY - this.startClient.y) >= DRAG_THRESHOLD) {
			this.moved = true;
			this.stub.remove();
		}
	}

	up(): Stub | void {
		if (!this.moved) return this.stub;
	}

	cancel() {
		this.stub.remove();
	}
}
