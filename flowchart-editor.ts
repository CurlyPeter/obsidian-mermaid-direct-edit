import { App, MarkdownView, Menu } from 'obsidian';
import type { Mermaid } from 'mermaid';
import { CURSOR_ADD, DiagramEditor } from './editor';
import { Gesture, NewLinkDrag, Stub, TapPress } from './gestures';
import type { LegendItem } from './legend';
import { NameModal } from './modals';
import { RenderHook, SourceRegistry } from './render';
import { EdgeEndDrag, FlowCtx, FlowNodeDrag, StubTap } from './flowchart-gestures';
import { FLOW_STUB_LENGTH, FlowHit, PLUS_BAND, classifyFlow } from './flowchart-hit';
import { FlowCluster, FlowEdge, FlowModel, FlowNode } from './flowchart-map';
import { DirectionModal, EdgeModal, GroupModal, NEW_GROUP, NodeChanges, NodeModal } from './flowchart-modals';
import type { ShapeType } from './flowchart-scan';
import {
	EditError, addEdge, addGroup, addLinkedNode, addNode, deleteEdge, deleteGroup, deleteNode, edgeAfter, edgeInfo, flowchartBlocker,
	getDirection, groupInfo, groupsOf, moveToGroup, newId, nodeInfo, read, relinkEdge, reverseEdge, setDirection, setEdge,
	setGroupDirection, setGroupTitle, setNodeColor, setNodeLabel, setNodeShape, ungroup,
} from './flowchart-text';

/** Rendering of flowcharts: editable unless the source is too large or the scanner cannot read it. */
export const flowchartRender: RenderHook = {
	kind: 'flowchart',
	roles: ['flowchart-v2', 'flowchart', 'flowchart-elk'],
	blocker: flowchartBlocker,
};

/** Legend entries: short names, outline icons (a white fill vanished on a dark theme). Fixed markup. */
const LEGEND_SHAPES: [ShapeType, string, string][] = [
	['square', 'Rectangle', "<rect x='3' y='3' width='18' height='10' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
	['round', 'Rounded', "<rect x='3' y='3' width='18' height='10' rx='3' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
	['stadium', 'Stadium', "<rect x='2' y='3' width='20' height='10' rx='5' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
	['diamond', 'Decision', "<path d='M12 1l9 7-9 7-9-7z' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
	['circle', 'Circle', "<circle cx='12' cy='8' r='6' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
	['cylinder', 'Database', "<path d='M6 4v8c0 2.7 12 2.7 12 0V4' fill='none' stroke='currentColor' stroke-width='1.3'/><ellipse cx='12' cy='4' rx='6' ry='2' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
	['subroutine', 'Subroutine', "<rect x='3' y='3' width='18' height='10' fill='none' stroke='currentColor' stroke-width='1.3'/><path d='M6 3v10M18 3v10' stroke='currentColor' stroke-width='1.3'/>"],
	['hexagon', 'Hexagon', "<path d='M6 3h12l4 5-4 5H6L2 8z' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
	['lean_right', 'Parallelogram', "<path d='M6 3h16l-4 10H2z' fill='none' stroke='currentColor' stroke-width='1.3'/>"],
];
export const FLOW_LEGEND: readonly LegendItem[] = [
	...LEGEND_SHAPES,
	['group', 'Group', "<rect x='2' y='2' width='20' height='12' rx='1' fill='none' stroke='currentColor' stroke-dasharray='3 2'/><rect x='7' y='6' width='10' height='5' fill='none' stroke='currentColor'/>"],
	['direction', 'Direction', "<path d='M4 8h14M14 4l4 4-4 4' fill='none' stroke='currentColor' stroke-width='1.5'/>"],
];
const legendName = (t: string) => LEGEND_SHAPES.find(([s]) => s === t)?.[1] ?? t;

/** Inline cursor per hit kind; '' leaves it to styles.css (nodes). */
const HOVER_CURSOR: Record<FlowHit['kind'], string> = {
	node: '', 'edge-label': 'pointer', 'edge-middle': 'pointer', 'edge-end': 'crosshair', plus: CURSOR_ADD, cluster: 'pointer',
};

/**
 * Graphical editing of rendered flowcharts (`flowchart` / `graph`), the same way Wardley maps are
 * edited: the shared `DiagramEditor` wires the DOM events, this class says what a press on a
 * flowchart means (`classifyFlow`), starts the gestures, runs the legend, the dialogs and the
 * context menu. Every edit is a validated text change of the block. On touch nothing is dragged
 * but a waiting stub's handle: swipes scroll, taps open dialogs (usability review 0.18.0). See
 * CLAUDE.md → "Editing flowcharts".
 */
export class FlowchartEditor extends DiagramEditor<FlowModel> implements FlowCtx {
	/** The legend's "Group": waiting for the node to put into a new group. */
	private armed: { box: Element; item: Element } | null = null;
	/** The "+" handles shown beside one node (hover, or a tap on touch). */
	private handles: { node: FlowNode; els: Element[]; timer: number | null } | null = null;
	private toldStub = false;

	constructor(app: App, registry: SourceRegistry, mermaid: () => Mermaid | undefined, enabled: () => boolean) {
		super(app, registry, mermaid, enabled, 'flowchart', { title: 'Flowchart', noun: 'flowchart' }, FLOW_LEGEND);
	}

	protected modelOf(svg: SVGSVGElement): FlowModel | null {
		const model = FlowModel.of(svg, this.registry);
		// Styles key on it: a diagram the editor refuses shows no edit cursors (code review 0.18.0).
		if (model?.blocked && !svg.hasAttribute('data-mp-blocked')) svg.setAttribute('data-mp-blocked', '');
		return model;
	}

	protected blockedReason(model: FlowModel): string | null {
		return model.blocked;
	}

	protected press(e: PointerEvent, model: FlowModel) {
		this.hideHandles();
		if (this.armed) return this.armedPress(e, model);
		const svg = model.svg;
		const touch = e.pointerType !== 'mouse';
		const hit = classifyFlow(model, e.target as Element, e.clientX, e.clientY, touch);
		if (!hit) return;
		if (touch) return this.touchPress(e, model, hit);
		switch (hit.kind) {
			case 'node': return this.start(e, new FlowNodeDrag(model, e, this, hit.node), svg);
			case 'edge-label':
			case 'edge-middle': {
				const edge = hit.edge;
				return this.start(e, new TapPress(model, e, () => this.openEdgeDialog(model, edge)), svg);
			}
			case 'edge-end': return this.start(e, new EdgeEndDrag(model, e, this, hit.edge, hit.end), svg);
			case 'plus': {
				this.stub = this.drawStub(model, hit.node, model.toSvg(e.clientX, e.clientY));
				return this.start(e, this.stubDrag(e, this.stub), svg);
			}
			case 'cluster': {
				const c = hit.cluster;
				return this.start(e, new TapPress(model, e, () => this.tap(c.g, model, () => this.openGroupDialog(model, c))), svg);
			}
		}
	}

	/** A finger: taps only. A tap on a node shows its "+" handles, a double tap its dialog. */
	private touchPress(e: PointerEvent, model: FlowModel, hit: FlowHit) {
		const svg = model.svg;
		switch (hit.kind) {
			case 'node': {
				const node = hit.node;
				return this.start(e, new TapPress(model, e, () => {
					this.showHandles(model, node, 4000);
					this.tap(node.g, model, () => this.openNodeDialog(model, node));
				}), svg);
			}
			case 'edge-label':
			case 'edge-middle':
			case 'edge-end': {
				const edge = hit.edge;
				return this.start(e, new TapPress(model, e, () => this.openEdgeDialog(model, edge)), svg);
			}
			case 'plus': return this.start(e, new StubTap(e, this.drawStub(model, hit.node, model.toSvg(e.clientX, e.clientY))), svg);
			case 'cluster': {
				const c = hit.cluster;
				return this.start(e, new TapPress(model, e, () => this.tap(c.g, model, () => this.openGroupDialog(model, c))), svg);
			}
		}
	}

	/** On touch nothing is claimed: a swipe that starts on the diagram scrolls, it never edits. */
	protected claims(model: FlowModel, target: Element, x: number, y: number, touch: boolean): boolean {
		return !touch && !model.blocked && !!classifyFlow(model, target, x, y);
	}

	protected cursorAt(model: FlowModel, target: Element, x: number, y: number): string {
		if (this.armed) return model.nodeOf(target) ? 'copy' : '';
		const hit = classifyFlow(model, target, x, y);
		return hit ? HOVER_CURSOR[hit.kind] : '';
	}

	/** The "+" handles follow the mouse: beside the node under it or near it. */
	protected hoverAt(model: FlowModel | null, target: Element | null, x: number, y: number) {
		if (!model || !target || this.armed || this.stub) return this.hideHandles();
		const node = model.nodeOf(target) ?? model.nodeAt(x, y, PLUS_BAND);
		if (!node) return this.hideHandles();
		this.showHandles(model, node, null);
	}

	/** A stub dropped on a node links to it; dropped on free space it creates a node linked from the stub's node. */
	protected stubDrag(e: PointerEvent, stub: Stub): Gesture {
		const model = stub.model as FlowModel;
		return new NewLinkDrag(e, stub, {
			targetAt: ev => {
				const n = model.nodeAt(ev.clientX, ev.clientY);
				return n ? { id: n.id, el: n.g } : null;
			},
			link: (from, to) => this.link(model, from, to),
			empty: from => this.newNodeAfter(model, from),
		});
	}

	/** While a stub waits, a press on another node of the same diagram links to it (click, then click). */
	protected stubPress(e: PointerEvent, stub: Stub): boolean {
		const model = stub.model as FlowModel;
		if (!model.svg.contains(e.target as Node)) return false;
		const node = model.nodeOf(e.target as Element) ?? model.nodeAt(e.clientX, e.clientY);
		if (!node || node.id === stub.from) return false;
		this.claim(e);
		this.swallowAfter(model.svg);
		stub.remove();
		this.link(model, stub.from, node.id);
		return true;
	}

	protected pressOutside() {
		this.disarm();
	}

	protected disarm() {
		this.armed?.item.removeClass('is-armed');
		this.armed = null;
	}

	protected legendAction(model: FlowModel, kind: string, item: Element) {
		if (kind === 'group') {
			this.disarm();
			this.armed = { box: model.svg.closest('.mermaid') ?? model.svg, item };
			item.addClass('is-armed');
			this.info(this.lastTouch ? 'tap a node to put it into a new group (tap elsewhere to cancel).' : 'click a node to put it into a new group (Escape cancels).');
			return;
		}
		if (kind === 'direction') return this.openDirectionDialog(model);
		this.addShape(model, kind as ShapeType);
	}

	protected contextMenu(e: MouseEvent, model: FlowModel): boolean {
		const hit = classifyFlow(model, e.target as Element, e.clientX, e.clientY);
		const menu = new Menu();
		const item = (title: string, icon: string, run: () => void) => menu.addItem(i => i.setTitle(title).setIcon(icon).onClick(run));
		if (hit?.kind === 'node' || hit?.kind === 'plus') {
			const node = hit.node;
			item('Edit node…', 'pencil', () => this.openNodeDialog(model, node));
			item('Add linked node…', 'plus', () => this.newNodeAfter(model, node.id));
			item('Put into a new group…', 'group', () => this.askNewGroup(model, node.id));
			menu.addSeparator();
			item('Delete node', 'trash-2', () => this.deleteNodeOf(model, node.id));
		} else if (hit?.kind === 'edge-label' || hit?.kind === 'edge-middle' || hit?.kind === 'edge-end') {
			const edge = hit.edge;
			item('Edit link…', 'pencil', () => this.openEdgeDialog(model, edge));
			item('Reverse link', 'arrow-left-right', () => { void this.apply(model, s => reverseEdge(s, edge.index)); });
			menu.addSeparator();
			item('Delete link', 'trash-2', () => this.applyThen(model, s => deleteEdge(s, edge.index), `link "${this.labelOf(model, edge.from)}" → "${this.labelOf(model, edge.to)}" deleted.`));
		} else if (hit?.kind === 'cluster') {
			const c = hit.cluster;
			item('Edit group…', 'pencil', () => this.openGroupDialog(model, c));
			item('Ungroup', 'ungroup', () => this.applyThen(model, s => ungroup(s, c.id), `group "${this.titleOf(model, c.id)}" dissolved, its nodes stay.`));
			menu.addSeparator();
			item('Delete group with its nodes', 'trash-2', () => this.applyThen(model, s => deleteGroup(s, c.id), `group "${this.titleOf(model, c.id)}" deleted with its nodes.`));
		} else {
			for (const [t, name] of LEGEND_SHAPES) item(`Add ${name.toLowerCase()}…`, 'plus', () => this.addShape(model, t));
			menu.addSeparator();
			item('Direction…', 'arrow-right', () => this.openDirectionDialog(model));
		}
		menu.showAtMouseEvent(e);
		return true;
	}

	// ---- FlowCtx -----------------------------------------------------------------------------

	openNodeDialog(model: FlowModel, node: FlowNode) {
		const { id } = node;
		let info: ReturnType<typeof nodeInfo>, groups: ReturnType<typeof groupsOf>;
		try { info = nodeInfo(model.src, id); groups = groupsOf(model.src); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		this.open(new NodeModal(this.app, { id, label: info.label, shape: info.shape, meta: info.meta, fill: info.fill, group: info.group?.id ?? null, groups },
			(c: NodeChanges) => {
				const look = (s: string) => {
					if (c.label !== undefined) s = setNodeLabel(s, id, c.label);
					if (c.shape !== undefined) s = setNodeShape(s, id, c.shape);
					if (c.color !== undefined) s = setNodeColor(s, id, c.color);
					return s;
				};
				if (c.group === NEW_GROUP) return this.askNewGroup(model, id, look);
				if (c.group === undefined) return void this.apply(model, look);
				const to = c.group;
				this.applyThen(model, s => moveToGroup(look(s), id, to), to ? `"${info.label}" moved into "${this.titleOf(model, to)}".` : `"${info.label}" moved out of its group.`);
			},
			() => this.deleteNodeOf(model, id),
		));
	}

	openEdgeDialog(model: FlowModel, edge: FlowEdge) {
		const { index } = edge;
		let info: ReturnType<typeof edgeInfo>, nodes: { id: string; label: string }[];
		try {
			info = edgeInfo(model.src, index);
			const flow = read(model.src);
			nodes = flow.vertexIds.map(id => ({ id, label: nodeInfo(model.src, id).label })).sort((a, b) => a.label.localeCompare(b.label));
		} catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		const name = (id: string) => nodes.find(n => n.id === id)?.label ?? id;
		this.open(new EdgeModal(this.app, { from: info.from, to: info.to, arrow: info.arrow, label: info.label, nodes },
			(arrow, label, from, to) => {
				const edit = (s: string) => {
					let t = setEdge(s, index, arrow, label);
					if (from === info.to && to === info.from) return reverseEdge(t, index);
					let at = index;
					if (from !== info.from) { t = relinkEdge(t, at, 'from', from); at = edgeAfter(t, at, from, info.to); }
					if (to !== info.to) t = relinkEdge(t, at, 'to', to);
					return t;
				};
				if (from === info.from && to === info.to) return void this.apply(model, edit);
				this.applyThen(model, edit, `link now runs "${name(from)}" → "${name(to)}".`);
			},
			() => this.applyThen(model, s => deleteEdge(s, index), `link "${name(info.from)}" → "${name(info.to)}" deleted.`),
		));
	}

	moveNode(model: FlowModel, id: string, group: string | null) {
		const label = this.labelOf(model, id);
		this.applyThen(model, s => moveToGroup(s, id, group), group ? `"${label}" moved into "${this.titleOf(model, group)}".` : `"${label}" moved out of its group.`);
	}

	relink(model: FlowModel, edge: FlowEdge, end: 'from' | 'to', id: string) {
		const from = end === 'from' ? id : edge.from, to = end === 'to' ? id : edge.to;
		this.applyThen(model, s => relinkEdge(s, edge.index, end, id), `link now runs "${this.labelOf(model, from)}" → "${this.labelOf(model, to)}".`);
	}

	// ---- dialogs and actions -------------------------------------------------------------------

	private openGroupDialog(model: FlowModel, cluster: FlowCluster) {
		const { id } = cluster;
		let info: ReturnType<typeof groupInfo>;
		try { info = groupInfo(model.src, id); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		this.open(new GroupModal(this.app, info,
			(title, dir) => {
				void this.apply(model, s => {
					if (title !== null) s = setGroupTitle(s, id, title);
					if (dir !== undefined) s = setGroupDirection(s, id, dir);
					return s;
				});
			},
			() => this.applyThen(model, s => ungroup(s, id), `group "${info.title}" dissolved, its nodes stay.`),
			() => this.applyThen(model, s => deleteGroup(s, id), `group "${info.title}" deleted with its nodes.`),
		));
	}

	private openDirectionDialog(model: FlowModel) {
		let dir: ReturnType<typeof getDirection>;
		try { dir = getDirection(model.src); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		this.open(new DirectionModal(this.app, dir, d => { void this.apply(model, s => setDirection(s, d)); }));
	}

	private addShape(model: FlowModel, shape: ShapeType) {
		this.open(new NameModal(this.app, `New ${legendName(shape).toLowerCase()}`, 'Label', label => {
			const id = this.idFor(model, label);
			void this.applyThen(model, s => addNode(s, label, shape), `"${label.trim()}" added.`).then(done => this.flash(done, id));
		}));
	}

	private newNodeAfter(model: FlowModel, from: string) {
		this.open(new NameModal(this.app, `New node linked from "${this.labelOf(model, from)}"`, 'Label', label => {
			const id = this.idFor(model, label);
			void this.applyThen(model, s => addLinkedNode(s, from, label), `"${label.trim()}" added after "${this.labelOf(model, from)}".`).then(done => this.flash(done, id));
		}));
	}

	private link(model: FlowModel, from: string, to: string) {
		void this.applyThen(model, s => addEdge(s, from, to), `"${this.labelOf(model, from)}" linked to "${this.labelOf(model, to)}".`);
	}

	private askNewGroup(model: FlowModel, id: string, before: (s: string) => string = s => s) {
		this.open(new NameModal(this.app, `New group around "${this.labelOf(model, id)}"`, 'Title', title => {
			this.applyThen(model, s => addGroup(before(s), title, id), `group "${title.trim()}" made around "${this.labelOf(model, id)}".`);
		}));
	}

	private deleteNodeOf(model: FlowModel, id: string) {
		this.applyThen(model, s => deleteNode(s, id), `"${this.labelOf(model, id)}" deleted with its links.`);
	}

	// ---- internals -------------------------------------------------------------------------------

	/** A press while the legend's "Group" is armed: on a node it asks for the group's title. */
	private armedPress(e: PointerEvent, model: FlowModel) {
		const armed = this.armed!;
		this.disarm();
		const node = model.nodeOf(e.target as Element);
		// Obsidian may redraw the diagram between arming and this press: the redrawn one counts too.
		if (!node || !(armed.box.contains(model.svg) || !armed.box.isConnected)) return;
		this.claim(e);
		this.swallowAfter(model.svg);
		this.askNewGroup(model, node.id);
	}

	/** The "+" stub, from the node's border towards the pointer. */
	private drawStub(model: FlowModel, node: FlowNode, toward: { x: number; y: number }): Stub {
		const b = model.nodeBox(node);
		const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
		const dx = toward.x - c.x, dy = toward.y - c.y;
		const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
		const start = Number.isFinite(t) ? { x: c.x + dx * t, y: c.y + dy * t } : c;
		return Stub.draw(model, node.id, start, toward, FLOW_STUB_LENGTH, model.svg);
	}

	protected stubWaits() {
		if (this.toldStub) return;
		this.toldStub = true;
		this.info('drag the round end onto a node, or click the node to link; drag it into free space for a new node.');
	}

	/**
	 * Small "+" marks on the sides of a node where a press starts a link (usability review 0.18.0:
	 * the ring was invisible). Only where a press would really mean "+", and inside the diagram.
	 * Drawn on demand, never at rest, so the diagram stays a reading surface.
	 */
	private showHandles(model: FlowModel, node: FlowNode, ms: number | null) {
		if (this.handles?.node === node && this.handles.els.every(e => e.isConnected)) return;
		this.hideHandles();
		const r = node.g.getBoundingClientRect(), box = model.svg.getBoundingClientRect();
		const off = PLUS_BAND / 2 + 1;
		const sides = [[r.left - off, r.top + r.height / 2], [r.right + off, r.top + r.height / 2], [r.left + r.width / 2, r.top - off], [r.left + r.width / 2, r.bottom + off]];
		const scale = model.svg.getScreenCTM()?.a || 1;
		const doc = model.svg.ownerDocument;
		const els: Element[] = [];
		for (const [x, y] of sides) {
			if (x < box.left + 2 || x > box.right - 2 || y < box.top + 2 || y > box.bottom - 2) continue;
			const hit = classifyFlow(model, doc.elementFromPoint(x, y) ?? model.svg, x, y);
			if (hit?.kind !== 'plus' || hit.node !== node) continue;
			const p = model.toSvg(x, y), k = 1 / scale;
			const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
			g.setAttribute('class', 'mp-plus-handle');
			g.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${k})`);
			g.innerHTML = "<circle r='6'/><path d='M-3.2 0h6.4M0 -3.2v6.4'/>";
			model.svg.appendChild(g);
			els.push(g);
		}
		const timer = ms === null ? null : window.setTimeout(() => this.hideHandles(), ms);
		this.handles = { node, els, timer };
	}

	private hideHandles() {
		if (!this.handles) return;
		if (this.handles.timer !== null) window.clearTimeout(this.handles.timer);
		this.handles.els.forEach(e => e.remove());
		this.handles = null;
	}

	/**
	 * After a node is added, Mermaid lays the diagram out anew and the node may land far away:
	 * it flashes once in the redrawn diagram (usability review 0.18.0).
	 */
	private flash(done: { view: MarkdownView; next: string } | null, id: string) {
		if (!done || !id) return;
		const until = Date.now() + 3000;
		const own = new RegExp(`-flowchart-${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
		const look = () => {
			for (const svg of Array.from(done.view.containerEl.querySelectorAll<SVGSVGElement>('svg[data-mp-kind="flowchart"]'))) {
				if (this.registry.sourceOf(svg) !== done.next) continue;
				const g = Array.from(svg.querySelectorAll('g.node')).find(n => own.test(n.id));
				if (!g) continue;
				g.classList.add('mp-flash');
				(g as Element).scrollIntoView({ block: 'nearest', inline: 'nearest' });
				window.setTimeout(() => g.classList.remove('mp-flash'), 1600);
				return;
			}
			if (Date.now() < until) window.setTimeout(look, 120);
		};
		window.setTimeout(look, 120);
	}

	/** The id a node with this label will get (the edit computes the same from the same source). */
	private idFor(model: FlowModel, label: string): string {
		try { return newId(read(model.src), label); } catch { return ''; }
	}

	/** A node's label for titles and notices (its id if it has none). */
	private labelOf(model: FlowModel, id: string): string {
		try { return nodeInfo(model.src, id).label; } catch { return id; }
	}

	private titleOf(model: FlowModel, id: string): string {
		return model.flow?.subgraphs.find(s => s.id === id)?.title ?? id;
	}

	private get lastTouch(): boolean {
		return this.touchSeen;
	}
}
