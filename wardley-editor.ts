import { App, Menu, Notice } from 'obsidian';
import type { Mermaid } from 'mermaid';
import { CURSOR_ADD, CURSOR_DELETE, CURSOR_REMOVE, DiagramEditor } from './editor';
import { DBLCLICK_MS } from './geometry';
import { DeletePress, Gesture, NewLinkDrag, Stub, TapPress } from './gestures';
import { Glow, GlowRun, GlowTarget } from './wardley-glow';
import { NameModal } from './modals';
import { KEY_ATTR, SourceRegistry, isElement } from './render';
import { STUB_LENGTH, evolutionAt, visibilityAt } from './wardley-geometry';
import { AnnotationDrag, ForceDrag, GestureCtx, GroupLabelDrag, InertiaDrag, LinkEndDrag, NodeDrag, NoteDrag, TrendTipDrag } from './wardley-gestures';
import { Hit, classify, componentAt, dropTargetAt } from './wardley-hit';
import { LegendKind, WARDLEY_LEGEND } from './wardley-legend';
import { MapModel, MapNode } from './wardley-map';
import { EditModal, GroupModal, LabelChoice, LinkModal } from './wardley-modals';
import {
	CLASS_NAME, EditError, ForceKind, addAnnotation, addElement, addEvolve, addForce, addGroupMember, addLink, addNote, addToPipeline, classDefs,
	defaultEvolveTarget, deleteAnnotation, deleteElement, deleteEvolve, deleteForce, deleteGroup, deletePipeline, freeSpot, getAnnotation,
	getClasses, getLink, getMethod, groupsOf, hasInertia, type Method, nextGroupName, nextPipelineEvolution, pipelineOf, removeGroupMember,
	linkDirection, orientLink, rename, renameForce, renameGroup, setAnnotationText, setClass, setClasses, setGroupLabel, setInertia, setLinkDirection, setMethod, unlink, upperEnd,
} from './wardley-text';

/**
 * The group mode (DEV.md → "Editing groups (0.22.0)"): a click on a component puts it into the
 * group or takes it out, anything else ends it. One per editor.
 */
interface GroupEdit {
	/** Null until the first component clicked makes the new group. */
	name: string | null;
	/**
	 * The block as the note holds it now. A click is written before the map is redrawn, so the
	 * next one starts from here, not from the drawing; `replaced` are the sources it superseded.
	 */
	src: string;
	replaced: Set<string>;
	/** The map's container; a redraw may replace it, then the map is found again by `src`. */
	box: Element;
	/** Where redraws are watched, to put the mark back on the redrawn group (once per frame). */
	root: Element;
	observer: MutationObserver;
	scheduled: boolean;
	notice: Notice;
	/** The notice's text: gone when the notice was dismissed, which ends the mode too. */
	text: HTMLElement | null;
	/** Clicks are written one after the other. */
	queue: Promise<void>;
	/** The last component clicked: a double click's second click must not take it out again. */
	last: { member: string; at: number } | null;
}

/** Inline cursor per hit kind; '' leaves it to styles.css (nodes, labels, notes, bars, boxes). */
const HOVER_CURSOR: Record<Hit['kind'], string> = {
	annotation: '', note: '', 'group-label': '', force: '', inertia: '', node: '', box: '', group: 'pointer',
	'trend-tip': 'ew-resize', 'trend-shaft': CURSOR_DELETE, 'link-end': 'crosshair', 'link-middle': 'pointer', plus: CURSOR_ADD,
};

/** The component a press in the group mode means: its circle or label, its pipeline box, its "+" ring. */
const memberHit = (hit: Hit | null): MapNode | null =>
	hit && (hit.kind === 'node' || hit.kind === 'box' || hit.kind === 'plus') ? hit.node : null;

/**
 * A node's shadow target: its group, the pipeline box that stands for a pipeline parent, and with
 * `links` every link line at it, so its connections show in a dense map.
 */
const nodeGlow = (model: MapModel, node: MapNode, links = true): GlowTarget => ({
	node: node.node,
	box: model.pipelineBoxes().find(b => b.parent === node.name)?.box ?? null,
	links: links ? model.linksAt(node.center).map(l => l.el) : [],
});

/**
 * What gets the shadow for a hit: a node (its circle, label, "+" ring or pipeline box) with its
 * links, or a link (its middle; on hover also its ends). Pressed, a node shows without its links
 * and a link end not at all: a drag moves those lines away from their shadow.
 */
function glowOf(model: MapModel, hit: Hit | null, hover: boolean): GlowTarget | null {
	const node = memberHit(hit);
	if (node) return nodeGlow(model, node, hover);
	if (hit?.kind === 'link-middle' || (hover && hit?.kind === 'link-end')) return { line: hit.line };
	return null;
}

const glowElement = (t: GlowTarget | null) => (t ? ('line' in t ? t.line : t.node) : null);

/**
 * Graphical editing of rendered `wardley-beta` maps. The shared `DiagramEditor` wires the DOM
 * events; this class says what a press on a map means (`classify`, one priority order), starts
 * the gestures, runs the legend and the dialogs. Every edit is a validated text change of the
 * block. See CLAUDE.md → "Editing Wardley maps".
 */
export class WardleyEditor extends DiagramEditor<MapModel> implements GestureCtx {
	/** Evolve, inertia or pipeline: the legend item waiting for a component to be pressed. */
	private armed: { kind: 'evolve' | 'inertia' | 'pipeline'; box: Element; item: Element } | null = null;
	private group: GroupEdit | null = null;
	private toldStub = false;
	/** The shadow (DEV.md 0.26.0): what a press would take, what is pressed, what has its dialog open. */
	private readonly glow = new Glow(line => this.runOf(line));
	private hovered: GlowTarget | null = null;
	private pressed: GlowTarget | null = null;
	private readonly held = new Set<GlowTarget>();
	/** The last hover classification, shared by `hoverAt` and `cursorAt` (one per mouse move). */
	private lastHover: { model: MapModel; target: Element; x: number; y: number; hit: Hit | null } | null = null;

	constructor(app: App, registry: SourceRegistry, mermaid: () => Mermaid | undefined, enabled: () => boolean) {
		super(app, registry, mermaid, enabled, 'wardley', { title: 'Wardley map', noun: 'map' }, WARDLEY_LEGEND);
	}

	protected modelOf(svg: SVGSVGElement): MapModel | null {
		return MapModel.of(svg, this.registry);
	}

	protected press(e: PointerEvent, model: MapModel) {
		if (this.armed) return this.armedPress(e, model);
		if (this.group && this.groupPress(e, model)) return;
		const svg = model.svg;
		const hit = classify(model, e.target as Element, e.clientX, e.clientY);
		if (!hit) return;
		// A link whose end is dragged moves away from its shadow: only the dragged node keeps one.
		this.hovered = null;
		this.pressed = glowOf(model, hit, false);
		this.refreshGlow();
		switch (hit.kind) {
			case 'annotation': return this.start(e, new AnnotationDrag(model, e, this, hit), svg);
			case 'note': return this.start(e, new NoteDrag(model, e, this, hit.el, hit.text), svg);
			case 'group-label': return this.start(e, new GroupLabelDrag(model, e, this, hit.el, hit.name), svg);
			case 'group': {
				const name = hit.name;
				return this.start(e, new TapPress(model, e, () => this.groupTap(model, name)), svg);
			}
			case 'force': return this.start(e, new ForceDrag(model, e, this, hit.force, hit.name, hit.parts, hit.origin), svg);
			case 'inertia': return this.start(e, new InertiaDrag(model, e, this, hit.bar, hit.name), svg);
			case 'node': return this.start(e, new NodeDrag(model, e, this, hit.node, hit.label), svg);
			case 'box': return this.start(e, new NodeDrag(model, e, this, hit.node, null), svg);
			case 'trend-tip': return this.start(e, new TrendTipDrag(model, e, this, hit.line, hit.name), svg);
			case 'trend-shaft': {
				const name = hit.name;
				return this.start(e, new DeletePress(model, e, this, s => deleteEvolve(s, name), `evolve arrow of "${name}" deleted.`), svg);
			}
			case 'link-end': return this.start(e, new LinkEndDrag(model, e, this, hit.line, hit.end, hit.names), svg);
			case 'link-middle': {
				const [a, b] = hit.names, line = hit.line;
				return this.start(e, new TapPress(model, e, () => this.openLinkDialog(model, a, b, line)), svg);
			}
			case 'plus': {
				const parent = svg.querySelector('g.wardley-links') ?? svg;
				this.stub = Stub.draw(model, hit.node.name, hit.node.center, model.toSvg(e.clientX, e.clientY), STUB_LENGTH, parent);
				return this.start(e, this.stubDrag(e, this.stub), svg);
			}
		}
	}

	protected claims(model: MapModel, target: Element, x: number, y: number, touch: boolean): boolean {
		const hit = classify(model, target, x, y);
		// A finger on a group's area may be scrolling the note: a tap still reaches the group.
		return !!hit && !(touch && hit.kind === 'group');
	}

	protected hoverAt(model: MapModel | null, target: Element | null, x: number, y: number) {
		const hit = model && target && !this.armed && !this.group ? this.hitAt(model, target, x, y) : null;
		// Compared by element first: building a node's target reads the map's pipeline boxes.
		const el = memberHit(hit)?.node ?? (hit?.kind === 'link-middle' || hit?.kind === 'link-end' ? hit.line : null);
		if (el === glowElement(this.hovered)) return;
		this.hovered = model ? glowOf(model, hit, true) : null;
		this.refreshGlow();
	}

	protected ended(_g: Gesture) {
		this.pressed = null;
		this.refreshGlow();
	}

	protected dropStub() {
		super.dropStub();
		this.refreshGlow();
	}

	protected stubWaits() {
		this.refreshGlow();
		if (this.toldStub) return;
		this.toldStub = true;
		this.info('drag the round end onto a component, or click the component to link; drag it into free space for a new component.');
	}

	destroy(docs: Iterable<Document>) {
		this.hovered = this.pressed = null;
		this.held.clear();
		this.glow.clear();
		super.destroy(docs);
	}

	protected cursorAt(model: MapModel, target: Element, x: number, y: number): string {
		if (this.armed) return componentAt(model, target) ? 'copy' : '';
		if (this.group && this.inGroupMap(model)) {
			const hit = this.hitAt(model, target, x, y);
			const node = memberHit(hit);
			if (node) return this.members().has(node.name) ? CURSOR_REMOVE : CURSOR_ADD;
			return hit?.kind === 'group-label' ? '' : hit?.kind === 'group' ? 'pointer' : 'default';
		}
		const hit = this.hitAt(model, target, x, y);
		return hit ? HOVER_CURSOR[hit.kind] : '';
	}

	/**
	 * A stub dropped on a node links to it; dropped on free space it creates a component right
	 * there, linked from the stub's node (decision 2026-10-11, same gesture as in flowcharts).
	 */
	protected stubDrag(e: PointerEvent, stub: Stub): Gesture {
		const model = stub.model as MapModel;
		return new NewLinkDrag(e, stub, {
			targetAt: ev => {
				const n = dropTargetAt(model, ev.clientX, ev.clientY);
				return n ? { id: n.name, el: n.node } : null;
			},
			link: (from, to) => { void this.apply(model, s => orientLink(addLink(s, from, to), from, to)); },
			empty: (from, at) => {
				const v = visibilityAt(model.box, at.y), ev = evolutionAt(model.box, at.x);
				const node = model.byName(from);
				this.open(new NameModal(this.app, `New component linked from "${from}"`, 'Name', name => {
					void this.apply(model, s => orientLink(addLink(addElement(s, 'component', name, v, ev), from, name.trim()), from, name.trim()));
				}), node ? this.hold(nodeGlow(model, node)) : undefined);
			},
		});
	}

	/** While a stub waits, a press on another component of the same map links to it (click, then click). */
	protected stubPress(e: PointerEvent, stub: Stub): boolean {
		const model = stub.model as MapModel;
		if (!model.svg.contains(e.target as Node)) return false;
		const node = componentAt(model, e.target as Element) ?? dropTargetAt(model, e.clientX, e.clientY);
		if (!node || node.name === stub.from) return false;
		this.claim(e);
		this.swallowAfter(model.svg);
		stub.remove();
		const from = stub.from, to = node.name;
		void this.apply(model, s => orientLink(addLink(s, from, to), from, to));
		return true;
	}

	protected pressOutside(e: PointerEvent) {
		// The group mode's own notice (its buttons) is not "elsewhere".
		if (isElement(e.target) && e.target.closest('.notice')?.querySelector('.mp-group-notice')) return;
		this.disarm();
	}

	protected disarm() {
		this.armed?.item.removeClass('is-armed');
		this.armed = null;
		this.endGroup();
	}

	protected isArmed(): boolean {
		return !!this.armed || !!this.group;
	}

	/** `write` keeps the group mode's source current: its next click starts from what was written. */
	protected async write(model: MapModel, edit: (src: string) => string, src = model.src) {
		const done = await super.write(model, edit, src);
		const g = this.group;
		if (done && g && src === g.src) {
			g.replaced.add(src);
			g.src = done.next;
		}
		return done;
	}

	// ---- GestureCtx: dialogs -------------------------------------------------------------------

	openNodeDialog(model: MapModel, node: MapNode) {
		const { name } = node;
		const isComponent = node.node.classList.contains('wardley-node--component');
		let inertia: boolean | null = null;
		let pipeline: string[] | null = null;
		let method: Method | null | undefined;
		if (isComponent) {
			try { inertia = hasInertia(model.src, name); pipeline = pipelineOf(model.src, name); } catch { /* duplicate name */ }
			try { method = getMethod(model.src, name); } catch { /* pipeline component: no type in wardley-beta */ }
		}
		this.open(new EditModal(this.app, {
			title: `Edit "${name}"`,
			name,
			inertia,
			method,
			highlight: getClasses(model.src, name).includes('highlight'),
			// One edit for everything that changed; the rename last, the other edits use the old name.
			onSave: c => {
				void this.apply(model, s => {
					if (c.inertia !== undefined) s = setInertia(s, name, c.inertia);
					if (c.method !== undefined) s = setMethod(s, name, c.method);
					if (c.highlight !== undefined) s = setClass(s, name, 'highlight', c.highlight);
					if (c.name !== undefined) s = rename(s, name, c.name);
					return s;
				});
			},
			deleteConfirm: 'Really delete, with its links?',
			onDelete: () => this.applyThen(model, s => deleteElement(s, name), `"${name}" deleted with its links.`),
			extra: pipeline ? {
				label: 'Remove pipeline',
				onClick: () => this.applyThen(model, s => deletePipeline(s, name), `pipeline of "${name}" removed.`),
			} : undefined,
		}), this.hold(nodeGlow(model, node)));
	}

	/** A click on a group's label or free area starts its group mode; a second one opens its dialog. */
	groupTap(model: MapModel, name: string) {
		if (this.group?.name !== name) this.startGroup(model, name);
		this.tap(`group:${name}`, model, () => {
			this.endGroup();
			this.openGroupDialog(model, name);
		});
	}

	/** Name, look (one class), label and delete of a group; its members change in the group mode. */
	openGroupDialog(model: MapModel, name: string) {
		const src = model.src;
		const g = groupsOf(src).find(x => x.name === name);
		if (!g) return void this.fail(`There is no group "${name}" in this map.`);
		const defined = [...new Set(classDefs(src).map(d => d.name).filter(n => CLASS_NAME.test(n) && n !== 'highlight'))];
		const label: LabelChoice = !g.label ? 'off' : g.label[0] || g.label[1] ? 'keep' : 'auto';
		this.open(new GroupModal(this.app, {
			name,
			classes: getClasses(src, name),
			defined,
			label,
			// One edit for everything that changed; the rename last, the other edits use the old name.
			onSave: c => {
				void this.apply(model, s => {
					if (c.cls !== undefined) s = setClasses(s, name, c.cls ? [c.cls] : []);
					if (c.label === 'off' || c.label === 'auto') s = setGroupLabel(s, name, c.label === 'off' ? null : 'auto');
					if (c.name !== undefined) s = renameGroup(s, name, c.name);
					return s;
				});
			},
			onDelete: () => void this.applyThen(model, s => deleteGroup(s, name), `group "${name}" deleted, its components stay.`),
		}));
	}

	openForceDialog(model: MapModel, kind: ForceKind, name: string) {
		this.open(new EditModal(this.app, {
			title: `Edit ${kind} "${name}"`,
			name,
			inertia: null,
			onSave: c => { if (c.name !== undefined) void this.apply(model, s => renameForce(s, kind, name, c.name!)); },
			deleteConfirm: 'Really delete?',
			onDelete: () => this.applyThen(model, s => deleteForce(s, kind, name), `${kind} "${name}" deleted.`),
		}));
	}

	openAnnotationDialog(model: MapModel, number: number) {
		let text: string;
		try { text = getAnnotation(model.src, number); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		this.open(new EditModal(this.app, {
			title: `Edit annotation ${number}`,
			name: text,
			field: 'Text',
			inertia: null,
			onSave: c => { if (c.name !== undefined) void this.apply(model, s => setAnnotationText(s, number, c.name!)); },
			deleteConfirm: 'Really delete?',
			onDelete: () => this.applyThen(model, s => deleteAnnotation(s, number), `annotation ${number} deleted.`),
		}));
	}

	// ---- internals ---------------------------------------------------------------------------

	/** `classify` once per mouse move: hover and cursor ask for the same point. */
	private hitAt(model: MapModel, target: Element, x: number, y: number): Hit | null {
		const h = this.lastHover;
		if (h && h.model === model && h.target === target && h.x === x && h.y === y) return h.hit;
		const hit = classify(model, target, x, y);
		this.lastHover = { model, target, x, y, hit };
		return hit;
	}

	/** Hover, press, open dialogs and a waiting link's node: the elements that show the shadow now. */
	private refreshGlow() {
		const stub = this.stub?.line.isConnected ? this.stub : null;
		const model = stub?.model as MapModel | undefined;
		const from = model ? model.byName(stub!.from) : null;
		this.glow.show([this.hovered, this.pressed, ...this.held, model && from ? nodeGlow(model, from) : null]);
	}

	/** Keeps the shadow on `t` while a dialog is open; the answer, called on close, takes it away. */
	private hold(t: GlowTarget): () => void {
		this.held.add(t);
		this.refreshGlow();
		return () => { this.held.delete(t); this.refreshGlow(); };
	}

	/**
	 * Which way a link's shadow runs. A dependency (`A -> B`: A needs B, also dashed) runs from B to
	 * A, from what supports to what it supports, the way energy flows up the value chain (maintainer
	 * 2026-10-17); Mermaid draws `x1` at the text's `from`, so that is towards the first end. A flow
	 * runs towards its head, `+<>` not at all.
	 */
	private runOf(line: SVGLineElement): GlowRun {
		const svg = line.ownerSVGElement;
		const model = svg ? this.modelOf(svg) : null;
		const a = model?.ownerAt(Number(line.getAttribute('x1')), Number(line.getAttribute('y1')));
		const b = model?.ownerAt(Number(line.getAttribute('x2')), Number(line.getAttribute('y2')));
		if (!model || !a || !b) return 'backward';
		try {
			const kind = getLink(model.src, a.name, b.name).kind;
			return kind === 'both' ? 'none' : kind === 'forward' ? 'forward' : 'backward';
		} catch {
			return 'backward';
		}
	}

	private openLinkDialog(model: MapModel, a: string, b: string, line: SVGLineElement) {
		let link: ReturnType<typeof getLink>, upper: string;
		try { link = getLink(model.src, a, b); upper = upperEnd(model.src, a, b); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		const lower = upper === link.from ? link.to : link.from;
		const direction = linkDirection(link, upper);
		const highlight = getClasses(model.src, [a, b]).includes('highlight');
		const upward = orientLink(model.src, a, b) !== model.src;
		const held = this.hold({ line });
		this.open(new LinkModal(this.app, { upper, lower, direction, label: link.label, highlight, upward },
			// Only what changed: setLink rewrites the line, which would fold an inline flow label.
			(dir, label, on) => {
				void this.apply(model, s => {
					s = dir !== direction || label.trim() !== link.label ? setLinkDirection(s, a, b, dir, label, upper) : orientLink(s, a, b);
					if (on !== highlight) s = setClass(s, [link.from, link.to], 'highlight', on);
					return s;
				});
			},
			() => this.applyThen(model, s => unlink(s, a, b), `link "${link.from}" – "${link.to}" deleted.`),
		), held);
	}

	// ---- the group mode ------------------------------------------------------------------------

	/** The legend's "Group": a new group, or one of the map's groups, to edit in the group mode. */
	private chooseGroup(model: MapModel, item: Element) {
		const groups = groupsOf(model.src);
		if (!groups.length) return this.startGroup(model, null);
		const menu = new Menu();
		menu.addItem(i => i.setTitle('New group').setIcon('plus').onClick(() => this.startGroup(model, null)));
		menu.addSeparator();
		for (const g of groups) menu.addItem(i => i.setTitle(g.name).setIcon('circle-dashed').onClick(() => this.startGroup(model, g.name)));
		const r = item.getBoundingClientRect();
		// Obsidian closes a menu on a mousedown outside it, and this press's own mousedown comes
		// after the pointerdown that got here: open it once the press is over.
		const win = item.ownerDocument.defaultView ?? window;
		let shown = false;
		const show = () => {
			if (shown) return;
			shown = true;
			menu.showAtPosition({ x: r.left, y: r.bottom });
		};
		win.addEventListener('pointerup', () => win.setTimeout(show, 0), { once: true, capture: true });
		win.setTimeout(show, 1500);
	}

	private startGroup(model: MapModel, name: string | null) {
		this.disarm();
		// The note's tab, or the zoom when the map is edited there.
		const root = model.svg.closest('.mde-zoom, .workspace-leaf-content') ?? model.svg.ownerDocument.body;
		const g: GroupEdit = {
			name, src: model.src, replaced: new Set(), box: model.svg.closest('.mermaid') ?? model.svg, root,
			observer: new MutationObserver(() => {
				if (g.scheduled) return;
				g.scheduled = true;
				window.requestAnimationFrame(() => { g.scheduled = false; this.mark(); });
			}),
			scheduled: false, notice: new Notice('', 0), text: null, queue: Promise.resolve(), last: null,
		};
		g.observer.observe(root, { childList: true, subtree: true });
		this.group = g;
		this.tell();
		this.mark();
	}

	private endGroup() {
		const g = this.group;
		if (!g) return;
		this.group = null;
		g.observer.disconnect();
		g.notice.hide();
		g.box.ownerDocument.querySelectorAll('.mp-group-editing').forEach(el => el.classList.remove('mp-group-editing'));
	}

	/** The mode's notice: what a click does, "Properties…" for a group that exists, "Done". */
	private tell() {
		const g = this.group;
		if (!g) return;
		const verb = this.touchSeen ? 'tap' : 'click';
		g.notice.setMessage(createFragment(f => {
			g.text = f.createSpan({
				cls: 'mp-group-notice',
				text: g.name ? `Wardley map: Group "${g.name}": ${verb} components to put them in or take them out. ` : `Wardley map: New group: ${verb} components to put them into it. `,
			});
			// A click on the text dismisses an Obsidian notice: that ends the mode as well.
			g.text.addEventListener('click', () => this.endGroup());
			const button = (text: string, run: () => void) => f.createEl('button', { text, cls: 'mp-undo' }).addEventListener('click', ev => {
				ev.stopPropagation();
				run();
			});
			if (g.name) {
				const name = g.name;
				button('Properties…', () => {
					const model = this.groupModel(g);
					this.endGroup();
					if (model) this.openGroupDialog(model, name);
				});
			}
			button('Done', () => this.endGroup());
		}));
	}

	/** Whether `model` is the map being edited (its drawing may still be the one before the last click). */
	private inGroupMap(model: MapModel): boolean {
		const g = this.group;
		return !!g && (model.src === g.src || g.replaced.has(model.src) || (g.box.isConnected && g.box.contains(model.svg)));
	}

	/** The drawing of the map being edited now, the redrawn one once it is there. */
	private groupModel(g: GroupEdit): MapModel | null {
		const svgs = Array.from(g.root.querySelectorAll<SVGSVGElement>(`svg[${KEY_ATTR}]`));
		const svg = svgs.find(s => this.registry.sourceOf(s) === g.src) ?? (g.box.isConnected ? svgs.find(s => g.box.contains(s)) : undefined);
		return svg ? MapModel.of(svg, this.registry) : null;
	}

	/** Marks the group being edited (a glow behind its boundary), again after every redraw. */
	private mark() {
		const g = this.group;
		if (!g) return;
		const model = this.groupModel(g);
		g.root.querySelectorAll('.mp-group-editing').forEach(el => el.classList.remove('mp-group-editing'));
		if (!model || !g.name) return;
		g.box = model.svg.closest('.mermaid') ?? model.svg;
		const i = groupsOf(model.src).findIndex(x => x.name === g.name);
		model.svg.querySelector(`g.mde-group[data-mde-group="${i}"]`)?.classList.add('mp-group-editing');
	}

	/** The members of the group being edited, as the note holds it now. */
	private members(): Set<string> {
		const g = this.group;
		return new Set(g?.name ? groupsOf(g.src).find(x => x.name === g.name)?.members ?? [] : []);
	}

	/**
	 * A press in the group mode: on a component (its circle, label, pipeline box or "+" ring) a
	 * click puts it in or takes it out and a drag still moves it; a group's label or area keeps or
	 * switches the mode; anything else ends the mode and does nothing more. False when the press is on
	 * another map: the mode ends and the press is handled as usual.
	 */
	private groupPress(e: PointerEvent, model: MapModel): boolean {
		const g = this.group!;
		if (!g.text?.isConnected || !this.inGroupMap(model)) {
			this.endGroup();
			return false;
		}
		// Someone else changed the map (not a drawing older than our last click): start from that.
		if (model.src !== g.src && !g.replaced.has(model.src)) g.src = model.src;
		const svg = model.svg;
		const hit = classify(model, e.target as Element, e.clientX, e.clientY);
		if (hit?.kind === 'group-label') {
			this.start(e, new GroupLabelDrag(model, e, this, hit.el, hit.name), svg);
			return true;
		}
		if (hit?.kind === 'group') {
			// Its own area keeps the mode (a second click opens the dialog), another group's switches.
			const name = hit.name;
			this.start(e, new TapPress(model, e, () => this.groupTap(model, name)), svg);
			return true;
		}
		const node = memberHit(hit);
		if (node && hit?.kind === 'plus') {
			this.start(e, new TapPress(model, e, () => this.toggleMember(model, node.name)), svg);
		} else if (node) {
			this.start(e, new NodeDrag(model, e, this, node, hit?.kind === 'node' ? hit.label : null, () => this.toggleMember(model, node.name)), svg);
		} else {
			this.claim(e);
			this.swallowAfter(svg);
			this.endGroup();
		}
		return true;
	}

	/**
	 * Puts a component into the group being edited or takes it out. Written one after the other,
	 * each from the source the one before left; the first makes a new group, taking the last one
	 * out deletes the group (with Undo) and ends the mode.
	 */
	private toggleMember(model: MapModel, member: string) {
		const g = this.group;
		if (!g) return;
		const now = Date.now();
		if (g.last?.member === member && now - g.last.at < DBLCLICK_MS) return;
		g.last = { member, at: now };
		g.queue = g.queue.then(async () => {
			if (this.group !== g) return;
			const src = g.src;
			const name = g.name ?? nextGroupName(src);
			const members = groupsOf(src).find(x => x.name === name)?.members ?? [];
			const target = this.groupModel(g) ?? model;
			if (members.length === 1 && members[0] === member) {
				if (await this.applyThen(target, s => removeGroupMember(s, name, member), `group "${name}" deleted with its last component.`, src)) this.endGroup();
				return;
			}
			const inside = members.includes(member);
			const done = await this.write(target, s => (inside ? removeGroupMember(s, name, member) : addGroupMember(s, name, member)), src);
			if (!done || this.group !== g) return;
			if (g.name === null) {
				g.name = name;
				this.tell();
			}
			// No cursor on a phone: say what the tap did.
			if (this.touchSeen) this.info(inside ? `"${member}" taken out of "${name}".` : `"${member}" put into "${name}".`);
		});
	}

	/** A press while a legend action is armed: on a component it applies, anywhere else it disarms. */
	private armedPress(e: PointerEvent, model: MapModel) {
		const armed = this.armed!;
		this.disarm();
		const node = componentAt(model, e.target as Element);
		// Obsidian may redraw the map between arming and this press: the redrawn map counts too.
		if (!node || !(armed.box.contains(model.svg) || !armed.box.isConnected)) return;
		this.claim(e);
		this.swallowAfter(model.svg);
		const name = node.name;
		if (armed.kind === 'evolve') {
			void this.apply(model, s => addEvolve(s, name, defaultEvolveTarget(s, name)));
		} else if (armed.kind === 'inertia') {
			void this.apply(model, s => setInertia(s, name, true));
		} else {
			let evo = 0.5;
			try { evo = nextPipelineEvolution(model.src, name); } catch { /* addToPipeline reports it */ }
			this.open(new NameModal(this.app, `Add to the pipeline of "${name}"`, 'Component', child => {
				void this.apply(model, s => addToPipeline(s, name, child, evo));
			}));
		}
	}

	protected legendAction(model: MapModel, item: string, el: Element) {
		const kind = item as LegendKind;
		this.endGroup();
		if (kind === 'group') return this.chooseGroup(model, el);
		if (kind === 'evolve' || kind === 'inertia' || kind === 'pipeline') {
			this.disarm();
			this.armed = { kind, box: model.svg.closest('.mermaid') ?? model.svg, item: el };
			el.addClass('is-armed');
			const what = kind === 'evolve' ? 'an evolve arrow' : kind === 'inertia' ? 'inertia' : 'a pipeline (or a component to its pipeline)';
			this.info(`click a component to add ${what} (Escape cancels).`);
			return;
		}
		if (kind === 'accelerator' || kind === 'deaccelerator') {
			const at = freeSpot(model.src, 'component');
			this.open(new NameModal(this.app, `New ${kind}`, 'Name', name => {
				void this.apply(model, s => addForce(s, kind, name, at.visibility, at.evolution));
			}));
			return;
		}
		if (kind === 'annotation') {
			const at = freeSpot(model.src, 'component');
			this.open(new NameModal(this.app, 'New annotation', 'Text', text => {
				void this.apply(model, s => addAnnotation(s, text, at.visibility, at.evolution));
			}));
			return;
		}
		if (kind === 'note') {
			const at = freeSpot(model.src, 'note');
			this.open(new NameModal(this.app, 'New note', 'Text', text => {
				void this.apply(model, s => addNote(s, text, at.visibility, at.evolution));
			}));
			return;
		}
		if (kind !== 'component' && kind !== 'anchor') return;
		const at = freeSpot(model.src, kind);
		this.open(new NameModal(this.app, `New ${kind}`, 'Name', name => {
			void this.apply(model, s => addElement(s, kind, name, at.visibility, at.evolution));
		}));
	}
}
