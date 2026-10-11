import { Pt } from './geometry';
import type { Surface } from './gestures';
import { Flow, ScanError, scanCached } from './flowchart-scan';
import { KEY_ATTR, SourceRegistry } from './render';

export interface FlowNode {
	/** The node's id in the source. */
	id: string;
	g: SVGGElement;
}

export interface FlowEdge {
	/** Position in Mermaid's edge list (`linkStyle` numbering, the edit functions' index). */
	index: number;
	path: SVGPathElement;
	/** The label group, when the edge has a visible label. */
	label: Element | null;
	from: string;
	to: string;
}

export interface FlowCluster {
	id: string;
	g: SVGGElement;
	rect: SVGRectElement;
	label: Element | null;
}

/** One sampled point of an edge path, in the path's own coordinates, with its distance along. */
interface Sample { x: number; y: number; along: number }

/** Where a screen point lies relative to an edge: distance along it, off it, its length (screen px). */
export interface EdgeHit { along: number; perp: number; len: number }

/**
 * What the editor knows about one rendered flowchart: its source as scanned, and which drawn
 * element is which node, edge or subgraph. Built once per SVG and cached; a redraw makes a new SVG
 * and with it a new model.
 *
 * Identity comes from the drawing (node ids in `…-flowchart-<id>-<n>`, edge ids in `data-id`,
 * subgraph ids in the cluster's id) and places from the scanner. The two must agree exactly, else
 * the model is `blocked` and nothing is edited (decision A2, 2026-10-11).
 */
export class FlowModel implements Surface {
	private static cache = new WeakMap<SVGSVGElement, FlowModel>();

	readonly nodes: FlowNode[] = [];
	readonly edges: FlowEdge[] = [];
	readonly clusters: FlowCluster[] = [];
	readonly flow: Flow | null = null;
	/** Why this flowchart cannot be edited, or null. */
	readonly blocked: string | null = null;
	private samples = new Map<SVGPathElement, Sample[]>();

	private constructor(readonly svg: SVGSVGElement, readonly key: string, readonly src: string) {
		try {
			this.flow = scanCached(src);
		} catch (e) {
			this.blocked = e instanceof ScanError ? e.message : String(e);
			return;
		}
		this.blocked = this.read(this.flow);
		if (this.blocked) console.warn(`[mermaid-direct-edit] flowchart not editable: ${this.blocked}`);
	}

	/** The model of `svg`, or null when it is not one of this plugin instance's editable flowcharts. */
	static of(svg: SVGSVGElement, registry: SourceRegistry): FlowModel | null {
		const key = svg.getAttribute(KEY_ATTR) ?? '';
		const cached = FlowModel.cache.get(svg);
		if (cached && cached.key === key) return cached;
		const src = registry.sourceOf(svg);
		if (src === undefined) return null;
		const model = new FlowModel(svg, key, src);
		FlowModel.cache.set(svg, model);
		return model;
	}

	/** Reads the drawing and checks it against the scan; returns why they disagree, or null. */
	private read(flow: Flow): string | null {
		const prefix = this.svg.id ? `${this.svg.id}-` : '';
		const local = (el: Element) => (prefix && el.id.startsWith(prefix) ? el.id.slice(prefix.length) : el.id);
		const subgraphs = new Set(flow.subgraphs.map(s => s.id));
		for (const g of Array.from(this.svg.querySelectorAll<SVGGElement>('g.node'))) {
			const id = local(g);
			// `flowchart-<id>-<counter>`; an empty subgraph is drawn as a node named by its id alone.
			if (!id.startsWith('flowchart-')) {
				if (!subgraphs.has(id)) return `unknown element "${id}" in the drawing`;
				continue;
			}
			this.nodes.push({ id: id.slice('flowchart-'.length).replace(/-\d+$/, ''), g });
		}
		const drawn = new Set(this.nodes.map(n => n.id));
		const missing = flow.vertexIds.filter(id => !drawn.has(id));
		const extra = [...drawn].filter(id => !flow.nodes.has(id));
		if (missing.length || extra.length || drawn.size !== this.nodes.length) {
			return `nodes differ from the source (${[...missing, ...extra].slice(0, 3).join(', ')})`;
		}
		const byId = new Map(flow.edges.map(e => [e.id, e]));
		const labels = new Map<string, Element>();
		this.svg.querySelectorAll('g.edgeLabel g.label[data-id]').forEach(l => labels.set(l.getAttribute('data-id')!, l.closest('g.edgeLabel')!));
		for (const path of Array.from(this.svg.querySelectorAll<SVGPathElement>('path[data-edge][data-id]'))) {
			const e = byId.get(path.getAttribute('data-id')!);
			if (!e) return `edge "${path.getAttribute('data-id')}" is not in the source`;
			const label = labels.get(e.id) ?? null;
			const visible = label && label.getBoundingClientRect().width > 0 ? label : null;
			this.edges.push({ index: e.index, path, label: visible, from: e.from.id, to: e.to.id });
		}
		if (this.edges.length !== flow.edges.length || new Set(this.edges.map(e => e.index)).size !== flow.edges.length) {
			return `${flow.edges.length} edges in the source, ${this.edges.length} drawn`;
		}
		for (const g of Array.from(this.svg.querySelectorAll<SVGGElement>('g.cluster'))) {
			const id = local(g);
			const rect = g.querySelector<SVGRectElement>(':scope > rect');
			if (!subgraphs.has(id) || !rect) return `unknown group "${id}" in the drawing`;
			this.clusters.push({ id, g, rect, label: g.querySelector('.cluster-label') });
		}
		return null;
	}

	toSvg(clientX: number, clientY: number): Pt {
		const ctm = this.svg.getScreenCTM();
		const pt = this.svg.createSVGPoint();
		pt.x = clientX;
		pt.y = clientY;
		const p = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
		return { x: p.x, y: p.y };
	}

	toScreen(x: number, y: number): Pt {
		const ctm = this.svg.getScreenCTM();
		const pt = this.svg.createSVGPoint();
		pt.x = x;
		pt.y = y;
		const p = ctm ? pt.matrixTransform(ctm) : pt;
		return { x: p.x, y: p.y };
	}

	nodeOf(el: Element): FlowNode | null {
		const g = el.closest('g.node');
		return g ? this.nodes.find(n => n.g === g) ?? null : null;
	}

	edgeOfLabel(el: Element): FlowEdge | null {
		const g = el.closest('g.edgeLabel');
		return g ? this.edges.find(e => e.label === g) ?? null : null;
	}

	clusterOfLabel(el: Element): FlowCluster | null {
		const label = el.closest('.cluster-label');
		return label ? this.clusters.find(c => c.label === label) ?? null : null;
	}

	/** The node whose drawn box contains the screen point, grown by `margin` px (`except`: one being dragged). */
	nodeAt(x: number, y: number, margin = 0, except?: FlowNode): FlowNode | null {
		let best: FlowNode | null = null, area = Infinity;
		for (const n of this.nodes) {
			if (n === except) continue;
			const r = n.g.getBoundingClientRect();
			if (x < r.left - margin || x > r.right + margin || y < r.top - margin || y > r.bottom + margin) continue;
			if (r.width * r.height < area) { best = n; area = r.width * r.height; }
		}
		return best;
	}

	/** The innermost group whose box contains the screen point. */
	clusterAt(x: number, y: number): FlowCluster | null {
		let best: FlowCluster | null = null, area = Infinity;
		for (const c of this.clusters) {
			const r = c.rect.getBoundingClientRect();
			if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
			if (r.width * r.height < area) { best = c; area = r.width * r.height; }
		}
		return best;
	}

	/** The group whose outline runs within `band` screen px of the point (the innermost). */
	clusterBorderAt(x: number, y: number, band: number): FlowCluster | null {
		let best: FlowCluster | null = null, area = Infinity;
		for (const c of this.clusters) {
			const r = c.rect.getBoundingClientRect();
			const inX = x >= r.left - band && x <= r.right + band, inY = y >= r.top - band && y <= r.bottom + band;
			const near = (inY && (Math.abs(x - r.left) <= band || Math.abs(x - r.right) <= band))
				|| (inX && (Math.abs(y - r.top) <= band || Math.abs(y - r.bottom) <= band));
			if (near && r.width * r.height < area) { best = c; area = r.width * r.height; }
		}
		return best;
	}

	/** A node's box in SVG units of the root (for the stub). */
	nodeBox(n: FlowNode): { x: number; y: number; w: number; h: number } {
		const r = n.g.getBoundingClientRect();
		const a = this.toSvg(r.left, r.top), b = this.toSvg(r.right, r.bottom);
		return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
	}

	/** Where the screen point lies relative to an edge's path, in screen px. */
	edgeHit(e: FlowEdge, x: number, y: number): EdgeHit | null {
		const ctm = e.path.getScreenCTM();
		if (!ctm) return null;
		const pts = this.samplesOf(e.path);
		if (pts.length < 2) return null;
		const scale = Math.hypot(ctm.a, ctm.b) || 1;
		const pt = this.svg.createSVGPoint();
		pt.x = x;
		pt.y = y;
		const p = pt.matrixTransform(ctm.inverse());
		let best = { along: 0, perp: Infinity };
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1], b = pts[i];
			const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
			const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
			const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
			if (d < best.perp) best = { along: a.along + t * (b.along - a.along), perp: d };
		}
		return { along: best.along * scale, perp: best.perp * scale, len: pts[pts.length - 1].along * scale };
	}

	/** An edge's end point in screen px (`to`: where its arrow is). */
	edgeEnd(e: FlowEdge, end: 'from' | 'to'): Pt {
		const pts = this.samplesOf(e.path);
		const s = end === 'from' ? pts[0] : pts[pts.length - 1];
		const ctm = e.path.getScreenCTM();
		const pt = this.svg.createSVGPoint();
		pt.x = s?.x ?? 0;
		pt.y = s?.y ?? 0;
		const p = ctm ? pt.matrixTransform(ctm) : pt;
		return { x: p.x, y: p.y };
	}

	/** Points along a path every few units, computed once per path. */
	private samplesOf(path: SVGPathElement): Sample[] {
		let pts = this.samples.get(path);
		if (pts) return pts;
		pts = [];
		let total = 0;
		try { total = path.getTotalLength(); } catch { /* not rendered */ }
		const n = Math.max(2, Math.min(200, Math.ceil(total / 4)));
		for (let i = 0; i <= n; i++) {
			const along = (total * i) / n;
			const p = path.getPointAtLength(along);
			pts.push({ x: p.x, y: p.y, along });
		}
		this.samples.set(path, pts);
		return pts;
	}
}
