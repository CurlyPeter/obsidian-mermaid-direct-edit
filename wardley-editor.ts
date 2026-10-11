import { App } from 'obsidian';
import type { Mermaid } from 'mermaid';
import { CURSOR_ADD, CURSOR_DELETE, DiagramEditor } from './editor';
import { DeletePress, Gesture, NewLinkDrag, Stub, TapPress } from './gestures';
import { NameModal } from './modals';
import { SourceRegistry } from './render';
import { STUB_LENGTH, evolutionAt, visibilityAt } from './wardley-geometry';
import { AnnotationDrag, ForceDrag, GestureCtx, InertiaDrag, LinkEndDrag, NodeDrag, NoteDrag, TrendTipDrag } from './wardley-gestures';
import { Hit, classify, componentAt, dropTargetAt } from './wardley-hit';
import { LegendKind, WARDLEY_LEGEND } from './wardley-legend';
import { MapModel, MapNode } from './wardley-map';
import { EditModal, LinkModal } from './wardley-modals';
import {
	EditError, ForceKind, addAnnotation, addElement, addEvolve, addForce, addLink, addNote, addToPipeline, defaultEvolveTarget,
	deleteAnnotation, deleteElement, deleteEvolve, deleteForce, deletePipeline, freeSpot, getAnnotation, getLink, getMethod, hasInertia, type Method,
	nextPipelineEvolution, pipelineOf, rename, renameForce, setAnnotationText, setInertia, setLink, setMethod, unlink,
} from './wardley-text';

/** Inline cursor per hit kind; '' leaves it to styles.css (nodes, labels, notes, bars, boxes). */
const HOVER_CURSOR: Record<Hit['kind'], string> = {
	annotation: '', note: '', force: '', inertia: '', node: '', box: '',
	'trend-tip': 'ew-resize', 'trend-shaft': CURSOR_DELETE, 'link-end': 'crosshair', 'link-middle': 'pointer', plus: CURSOR_ADD,
};

/**
 * Graphical editing of rendered `wardley-beta` maps. The shared `DiagramEditor` wires the DOM
 * events; this class says what a press on a map means (`classify`, one priority order), starts
 * the gestures, runs the legend and the dialogs. Every edit is a validated text change of the
 * block. See CLAUDE.md → "Editing Wardley maps".
 */
export class WardleyEditor extends DiagramEditor<MapModel> implements GestureCtx {
	/** Evolve, inertia or pipeline: the legend item waiting for a component to be pressed. */
	private armed: { kind: 'evolve' | 'inertia' | 'pipeline'; box: Element; item: Element } | null = null;
	private toldStub = false;

	constructor(app: App, registry: SourceRegistry, mermaid: () => Mermaid | undefined, enabled: () => boolean) {
		super(app, registry, mermaid, enabled, 'wardley', { title: 'Wardley map', noun: 'map' }, WARDLEY_LEGEND);
	}

	protected modelOf(svg: SVGSVGElement): MapModel | null {
		return MapModel.of(svg, this.registry);
	}

	protected press(e: PointerEvent, model: MapModel) {
		if (this.armed) return this.armedPress(e, model);
		const svg = model.svg;
		const hit = classify(model, e.target as Element, e.clientX, e.clientY);
		if (!hit) return;
		switch (hit.kind) {
			case 'annotation': return this.start(e, new AnnotationDrag(model, e, this, hit), svg);
			case 'note': return this.start(e, new NoteDrag(model, e, this, hit.el, hit.text), svg);
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
				const [a, b] = hit.names;
				return this.start(e, new TapPress(model, e, () => this.openLinkDialog(model, a, b)), svg);
			}
			case 'plus': {
				const parent = svg.querySelector('g.wardley-links') ?? svg;
				this.stub = Stub.draw(model, hit.node.name, hit.node.center, model.toSvg(e.clientX, e.clientY), STUB_LENGTH, parent);
				return this.start(e, this.stubDrag(e, this.stub), svg);
			}
		}
	}

	protected claims(model: MapModel, target: Element, x: number, y: number): boolean {
		return !!classify(model, target, x, y);
	}

	protected cursorAt(model: MapModel, target: Element, x: number, y: number): string {
		if (this.armed) return componentAt(model, target) ? 'copy' : '';
		const hit = classify(model, target, x, y);
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
			link: (from, to) => { void this.apply(model, s => addLink(s, from, to)); },
			empty: (from, at) => {
				const v = visibilityAt(model.box, at.y), ev = evolutionAt(model.box, at.x);
				this.open(new NameModal(this.app, `New component linked from "${from}"`, 'Name', name => {
					void this.apply(model, s => addLink(addElement(s, 'component', name, v, ev), from, name.trim()));
				}));
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
		void this.apply(model, s => addLink(s, from, to));
		return true;
	}

	protected stubWaits() {
		if (this.toldStub) return;
		this.toldStub = true;
		this.info('drag the round end onto a component, or click the component to link; drag it into free space for a new component.');
	}

	protected pressOutside() {
		this.disarm();
	}

	protected disarm() {
		this.armed?.item.removeClass('is-armed');
		this.armed = null;
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
			// One edit for everything that changed; the rename last, the other edits use the old name.
			onSave: c => {
				void this.apply(model, s => {
					if (c.inertia !== undefined) s = setInertia(s, name, c.inertia);
					if (c.method !== undefined) s = setMethod(s, name, c.method);
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

	private openLinkDialog(model: MapModel, a: string, b: string) {
		let link: ReturnType<typeof getLink>;
		try { link = getLink(model.src, a, b); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		this.open(new LinkModal(this.app, link,
			(kind, label) => { void this.apply(model, s => setLink(s, a, b, kind, label)); },
			() => this.applyThen(model, s => unlink(s, a, b), `link "${link.from}" – "${link.to}" deleted.`),
		));
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
