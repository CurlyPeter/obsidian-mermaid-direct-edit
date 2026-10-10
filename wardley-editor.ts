import { App, Modal, Notice } from 'obsidian';
import type { Mermaid } from 'mermaid';
import { DBLCLICK_MS, STUB_GRAB, STUB_LENGTH, TapDetector } from './wardley-geometry';
import {
	AnnotationDrag, DeletePress, ForceDrag, Gesture, GestureCtx, InertiaDrag, LinkEndDrag, NewLinkDrag, NodeDrag, NoteDrag, Stub, TapPress,
	TrendTipDrag,
} from './wardley-gestures';
import { Hit, classify, componentAt } from './wardley-hit';
import { Legend, LegendKind } from './wardley-legend';
import { MapModel, MapNode, isElement, mapIn, mapOf } from './wardley-map';
import { EditModal, LinkModal, NameModal } from './wardley-modals';
import { KEY_ATTR, SourceRegistry, wrapRender } from './wardley-render';
import {
	EditError, ForceKind, addAnnotation, addElement, addEvolve, addForce, addNote, addToPipeline, defaultEvolveTarget,
	deleteAnnotation, deleteElement, deleteEvolve, deleteForce, deletePipeline, freeSpot, getAnnotation, getLink, getMethod, hasInertia, type Method,
	nextPipelineEvolution, pipelineOf, rename, renameForce, setAnnotationText, setInertia, setLink, setMethod, unlink,
} from './wardley-text';
import { viewOf, writeBlock } from './wardley-write';

const svgCursor = (body: string, fallback: string) =>
	`url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'>${body}</svg>`)}") 10 10, ${fallback}`;
const CURSOR_DELETE = svgCursor("<circle cx='10' cy='10' r='8' fill='#d33' stroke='white' stroke-width='1.5'/><path d='M6.6 6.6l6.8 6.8M13.4 6.6l-6.8 6.8' stroke='white' stroke-width='2'/>", 'pointer');
const CURSOR_ADD = svgCursor("<circle cx='10' cy='10' r='8' fill='white' stroke='#333' stroke-width='1.5'/><path d='M10 5.5v9M5.5 10h9' stroke='#333' stroke-width='2'/>", 'copy');

/** Inline cursor per hit kind; '' leaves it to styles.css (nodes, labels, notes, bars, boxes). */
const HOVER_CURSOR: Record<Hit['kind'], string> = {
	annotation: '', note: '', force: '', inertia: '', node: '', box: '',
	'trend-tip': 'ew-resize', 'trend-shaft': CURSOR_DELETE, 'link-end': 'crosshair', 'link-middle': 'pointer', plus: CURSOR_ADD,
};

/**
 * Graphical editing of rendered `wardley-beta` maps. This class only wires DOM events to the
 * parts that do the work: `classify` (what a press means, one priority order), the gestures
 * (one active at a time), the legend, the dialogs, and `apply`, which turns every edit into a
 * validated text change of the block. See CLAUDE.md → "Editing Wardley maps".
 */
export class WardleyEditor implements GestureCtx {
	private readonly registry = new SourceRegistry();
	private readonly legend = new Legend();
	private readonly taps = new TapDetector();
	/** The map container of the last tap, so a dblclick elsewhere does not claim it. */
	private tapBox: Element | null = null;
	/** The one gesture in progress (a second finger is ignored meanwhile, review finding #5). */
	private active: Gesture | null = null;
	/** A provisional link waiting for its free end to be dragged onto a node. */
	private stub: Stub | null = null;
	/** Evolve, inertia or pipeline: the legend item waiting for a component to be pressed. */
	private armed: { kind: 'evolve' | 'inertia' | 'pipeline'; box: Element; item: Element } | null = null;
	/** The click after a handled gesture targets the map (pointer capture); swallowed there only. */
	private swallow: { until: number; box: Element } | null = null;
	private readonly modals = new Set<Modal>();
	/** When an unknown map tag last caused a redraw. */
	private staleAt = 0;

	constructor(private app: App, private mermaid: () => Mermaid | undefined, private enabled: () => boolean) {}

	wrapRender(m: Mermaid) {
		wrapRender(m, this.registry);
	}

	// ---- event handlers (registered by main.ts in the capture phase) ----------------------

	onPointerDown = (e: PointerEvent) => {
		if (!this.enabled() || this.active || e.button !== 0 || !e.isPrimary) return;
		if (e.pointerType !== 'mouse') this.updateLegend(e);  // touch has no hover: a tap decides
		const stub = this.stub;
		if (stub && this.onStubEnd(stub, e)) return this.start(e, new NewLinkDrag(e, this, stub), stub.model.svg);
		if (stub) this.dropStub();

		if (Legend.contains(e.target)) {
			this.claim(e);
			const kind = Legend.itemAt(e.target);
			const svg = mapIn(e.target);
			if (kind && svg) this.legendAction(svg, kind, (e.target as Element).closest('[data-mp-add]')!);
			return;
		}
		const svg = mapOf(e.target);
		if (!svg) return void this.disarm();
		const model = MapModel.of(svg, this.registry);
		if (!model) {
			// Drawn by an earlier plugin load, or a tag forged in the note's HTML: one notice and
			// redraw per 10 s at most, so a forged tag cannot keep every open note redrawing (F5).
			this.claim(e);
			if (Date.now() - this.staleAt < 10_000) return;
			this.staleAt = Date.now();
			return void this.fail('This map was drawn by an earlier plugin load and is redrawn now, please try again.');
		}
		if (this.armed) return this.armedPress(e, model);

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
				this.stub = Stub.draw(model, hit.node, model.toSvg(e.clientX, e.clientY), STUB_LENGTH);
				return this.start(e, new NewLinkDrag(e, this, this.stub), svg);
			}
		}
	};

	onPointerMove = (e: PointerEvent) => {
		const g = this.active;
		if (g && e.pointerId === g.pointerId) {
			this.claim(e);
			return g.move(e);
		}
		if (g || e.pointerType !== 'mouse') return;
		this.updateLegend(e);
		this.hoverCursor(e);
	};

	onPointerUp = (e: PointerEvent) => {
		const g = this.active;
		if (!g || e.pointerId !== g.pointerId) return;
		this.claim(e);
		this.end(g, e);
		try {
			const waiting = g.up(e);
			if (waiting) this.stub = waiting;
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
		const svg = mapOf(e.target);
		const onElement = svg && MapModel.of(svg, this.registry) && classify(MapModel.of(svg, this.registry)!, e.target, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
		if (recent || onElement || Legend.contains(e.target)) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	/** The system's double click (follows OS timing; the target is the map after pointer capture). */
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
	 * per gesture with the same classification as a press; the rest of the map still scrolls.
	 */
	onTouchStart = (e: TouchEvent) => {
		if (!this.enabled()) return;
		const t = e.touches[0];
		if (Legend.contains(e.target)) return void e.preventDefault();
		const svg = mapOf(e.target);
		const model = svg ? MapModel.of(svg, this.registry) : null;
		if (!t || !model) return;
		if ((this.stub && this.onStubEnd(this.stub, t)) || classify(model, e.target as Element, t.clientX, t.clientY)) e.preventDefault();
	};

	onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'Escape') return;
		this.dropStub();
		this.disarm();
	};

	/** Undoes every trace of the editor in each of `docs`, the app's windows (plugin unload, review finding #6). */
	destroy(docs: Iterable<Document>) {
		this.active?.cancel();
		this.active = null;
		this.dropStub();
		this.disarm();
		this.taps.clear();
		this.legend.destroy(docs);
		for (const m of Array.from(this.modals)) m.close();
		for (const doc of docs) {
			doc.querySelectorAll<SVGSVGElement>(`svg[${KEY_ATTR}]`).forEach(svg => { svg.style.cursor = ''; });
			doc.querySelectorAll('.mp-drop-target, .mp-dragging').forEach(el => el.classList.remove('mp-drop-target', 'mp-dragging'));
		}
	}

	// ---- GestureCtx ------------------------------------------------------------------------

	/** Computes the new source, validates it with Mermaid, and writes it into the note. */
	async apply(model: MapModel, edit: (src: string) => string): Promise<boolean> {
		try {
			const view = viewOf(this.app, model.svg);
			if (!view?.file) return this.fail('Open the note itself to edit this map.');
			const src = model.src;
			let next: string;
			try {
				next = edit(src);
			} catch (e) {
				return this.fail(e instanceof EditError ? e.message : String(e));
			}
			if (next === src) { this.rerender(); return false; }
			try {
				await this.mermaid()?.parse(next);
			} catch (e) {
				return this.fail(`The edit would break the map, nothing was changed. ${e instanceof Error ? e.message : ''}`);
			}
			const refused = await writeBlock(this.app, view, src, next);
			return refused ? this.fail(refused) : true;
		} catch (e) {
			// e.g. the note was renamed or deleted mid-edit (review finding #8)
			this.report(e);
			return false;
		}
	}

	/** A confirmation: shown as a Notice and kept in the log (a Notice is gone after seconds). */
	info(message: string) {
		new Notice(`Wardley map: ${message}`);
		console.info(`[mermaid-direct-edit] ${message}`);
	}

	tap(key: unknown, model: MapModel, open: () => void) {
		this.tapBox = model.svg.closest('.mermaid') ?? model.svg;
		this.taps.tap(key, open);
	}

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
			onInertia: on => { void this.apply(model, s => setInertia(s, name, on)); },
			method: method === undefined ? undefined : { value: method, onChange: m => { void this.apply(model, s => setMethod(s, name, m)); } },
			onRename: newName => { void this.apply(model, s => rename(s, name, newName)); },
			deleteConfirm: 'Really delete, with its links?',
			onDelete: () => { void this.apply(model, s => deleteElement(s, name)).then(ok => { if (ok) this.info(`"${name}" deleted with its links.`); }); },
			extra: pipeline ? {
				label: 'Remove pipeline',
				onClick: () => { void this.apply(model, s => deletePipeline(s, name)).then(ok => { if (ok) this.info(`pipeline of "${name}" removed.`); }); },
			} : undefined,
		}));
	}

	openForceDialog(model: MapModel, kind: ForceKind, name: string) {
		this.open(new EditModal(this.app, {
			title: `Edit ${kind} "${name}"`,
			name,
			inertia: null,
			onRename: newName => { void this.apply(model, s => renameForce(s, kind, name, newName)); },
			deleteConfirm: 'Really delete?',
			onDelete: () => { void this.apply(model, s => deleteForce(s, kind, name)).then(ok => { if (ok) this.info(`${kind} "${name}" deleted.`); }); },
		}));
	}

	openAnnotationDialog(model: MapModel, number: number) {
		let text: string;
		try { text = getAnnotation(model.src, number); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		this.open(new EditModal(this.app, {
			title: `Edit annotation ${number}`,
			name: text,
			field: { label: 'Text', submit: 'Save' },
			inertia: null,
			onRename: next => { void this.apply(model, s => setAnnotationText(s, number, next)); },
			deleteConfirm: 'Really delete?',
			onDelete: () => { void this.apply(model, s => deleteAnnotation(s, number)).then(ok => { if (ok) this.info(`annotation ${number} deleted.`); }); },
		}));
	}

	// ---- internals ---------------------------------------------------------------------------

	private openLinkDialog(model: MapModel, a: string, b: string) {
		let link: ReturnType<typeof getLink>;
		try { link = getLink(model.src, a, b); } catch (e) { return void this.fail(e instanceof EditError ? e.message : String(e)); }
		this.open(new LinkModal(this.app, link,
			(kind, label) => { void this.apply(model, s => setLink(s, a, b, kind, label)); },
			() => { void this.apply(model, s => unlink(s, a, b)).then(ok => { if (ok) this.info(`link "${link.from}" – "${link.to}" deleted.`); }); },
		));
	}

	/** Opens a dialog and keeps track of it, so unload can close it. */
	private open(modal: Modal) {
		this.modals.add(modal);
		const onClose = modal.onClose.bind(modal);
		modal.onClose = () => { this.modals.delete(modal); onClose(); };
		modal.open();
	}

	private start(e: PointerEvent, gesture: Gesture, svg: SVGSVGElement) {
		this.claim(e);
		try { svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
		this.active = gesture;
	}

	private end(g: Gesture, e: PointerEvent) {
		this.active = null;
		this.swallow = { until: Date.now() + 500, box: g.model.svg.closest('.mermaid') ?? g.model.svg };
		try { if (g.model.svg.hasPointerCapture(e.pointerId)) g.model.svg.releasePointerCapture(e.pointerId); } catch { /* detached */ }
	}

	private claim(e: Event) {
		e.preventDefault();
		e.stopPropagation();
	}

	/** A press while a legend action is armed: on a component it applies, anywhere else it disarms. */
	private armedPress(e: PointerEvent, model: MapModel) {
		const armed = this.armed!;
		this.disarm();
		const node = componentAt(model, e.target as Element);
		// Obsidian may redraw the map between arming and this press: the redrawn map counts too.
		if (!node || !(armed.box.contains(model.svg) || !armed.box.isConnected)) return;
		this.claim(e);
		this.swallow = { until: Date.now() + 500, box: model.svg.closest('.mermaid') ?? model.svg };
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

	private legendAction(svg: SVGSVGElement, kind: LegendKind, item: Element) {
		const model = MapModel.of(svg, this.registry);
		if (!model) return void this.fail('This map was drawn by an earlier plugin load and is redrawn now, please try again.');
		if (kind === 'evolve' || kind === 'inertia' || kind === 'pipeline') {
			this.disarm();
			this.armed = { kind, box: svg.closest('.mermaid') ?? svg, item };
			item.addClass('is-armed');
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
		const at = freeSpot(model.src, kind);
		this.open(new NameModal(this.app, `New ${kind}`, 'Name', name => {
			void this.apply(model, s => addElement(s, kind, name, at.visibility, at.evolution));
		}));
	}

	private disarm() {
		this.armed?.item.removeClass('is-armed');
		this.armed = null;
	}

	private onStubEnd(stub: Stub, p: { clientX: number; clientY: number }): boolean {
		if (!stub.line.isConnected) return false;
		const end = stub.end();
		return Math.hypot(end.x - p.clientX, end.y - p.clientY) <= STUB_GRAB;
	}

	private dropStub() {
		this.stub?.remove();
		this.stub = null;
	}

	/** The legend of the map under the pointer (or of the legend under it), editable maps only. */
	private updateLegend(e: PointerEvent) {
		const target = isElement(e.target) ? e.target : null;
		const svg = this.enabled() ? mapOf(target) ?? mapIn(target) : null;
		const box = svg && MapModel.of(svg, this.registry) ? svg.closest<HTMLElement>('.mermaid') : null;
		this.legend.update(box, target, e.clientX, e.clientY);
	}

	/** Mouse hover: the cursor tells what a press would do (same classification as a press). */
	private hoverCursor(e: PointerEvent) {
		const svg = this.enabled() ? mapOf(e.target) : null;
		const model = svg ? MapModel.of(svg, this.registry) : null;
		if (!svg || !model) return;
		if (this.armed) {
			svg.style.cursor = componentAt(model, e.target as Element) ? 'copy' : '';
			return;
		}
		if (this.stub && this.onStubEnd(this.stub, e)) {
			svg.style.cursor = 'grab';
			return;
		}
		const hit = classify(model, e.target as Element, e.clientX, e.clientY);
		svg.style.cursor = hit ? HOVER_CURSOR[hit.kind] : '';
	}

	/** Reports a refused edit; the redraw puts a dragged element back where the source has it. */
	private fail(message: string): false {
		new Notice(`Wardley map: ${message}`);
		console.warn(`[mermaid-direct-edit] ${message}`);
		this.rerender();
		return false;
	}

	private report(e: unknown) {
		console.error('[mermaid-direct-edit] edit failed:', e);
		this.fail(`The edit failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	private rerender() {
		this.app.workspace.trigger('post-processor-change');
	}
}
