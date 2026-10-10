import { Box, END_TOLERANCE, Pt, xOf, yOf } from './wardley-geometry';
import { KEY_ATTR, SourceRegistry } from './wardley-render';
import { getPosition, pipelineOf, pipelineParents } from './wardley-text';

export interface MapNode {
	node: SVGGElement;
	name: string;
	/** Centre in SVG units (a pipeline parent: its square above the box, not its declaration). */
	center: Pt;
}

/**
 * The editable wardley SVG an event target belongs to, if any. A map embedded from another
 * note is left alone: its edit would be written into the host note (security review F3).
 */
export function mapOf(target: EventTarget | null): SVGSVGElement | null {
	if (!(target instanceof Element)) return null;
	const svg = target.closest<SVGSVGElement>(`svg[${KEY_ATTR}]`);
	return svg && svg.closest('.mermaid') && !svg.closest('.markdown-embed') ? svg : null;
}

/** The editable map in the `.mermaid` container around `target` (the legend sits beside the SVG). */
export function mapIn(target: EventTarget | null): SVGSVGElement | null {
	if (!(target instanceof Element)) return null;
	return mapOf(target.closest('.mermaid')?.querySelector(`:scope > svg[${KEY_ATTR}]`) ?? null);
}

export const nameOf = (node: Element) => node.querySelector('text.wardley-node-label')?.textContent?.trim() || null;

/**
 * What the editor knows about one rendered map: its source, plot area and node centres. Built
 * once per SVG element and cached (hover ran this per node on every mouse move before, review
 * finding #15); a redraw creates a new SVG and with it a new model. Centres come from the
 * source and from drawn attributes that a drag's `transform` never touches.
 */
export class MapModel {
	private static cache = new WeakMap<SVGSVGElement, MapModel>();

	readonly nodes: MapNode[] = [];
	readonly nodeRadius: number;

	private constructor(readonly svg: SVGSVGElement, readonly key: string, readonly src: string, readonly box: Box) {
		const circle = Array.from(svg.querySelectorAll('g.wardley-node > circle')).find(c => !c.getAttribute('class'));
		this.nodeRadius = Number(circle?.getAttribute('r') ?? 6);
		svg.querySelectorAll<SVGGElement>('g.wardley-node').forEach(node => {
			const name = nameOf(node);
			const center = name ? this.centerOf(node, name) : null;
			if (name && center) this.nodes.push({ node, name, center });
		});
	}

	/** The model of `svg`, or null when it is not one of this plugin instance's editable maps. */
	static of(svg: SVGSVGElement, registry: SourceRegistry): MapModel | null {
		const key = svg.getAttribute(KEY_ATTR) ?? '';
		const cached = MapModel.cache.get(svg);
		if (cached && cached.key === key) return cached;
		const src = registry.sourceOf(svg);
		const box = plotBox(svg);
		if (src === undefined || !box) return null;
		const model = new MapModel(svg, key, src, box);
		MapModel.cache.set(svg, model);
		return model;
	}

	private centerOf(node: SVGGElement, name: string): Pt | null {
		// A pipeline parent is drawn as a square above its box, away from its declared spot.
		const square = node.querySelector(':scope > rect');
		if (square) {
			return {
				x: Number(square.getAttribute('x')) + Number(square.getAttribute('width')) / 2,
				y: Number(square.getAttribute('y')) + Number(square.getAttribute('height')) / 2,
			};
		}
		let pos: ReturnType<typeof getPosition>;
		try { pos = getPosition(this.src, name); } catch { return null; }
		const x = xOf(this.box, pos.evolution);
		if (pos.visibility !== undefined) return { x, y: yOf(this.box, pos.visibility) };
		// A pipeline component declares only its evolution; its height is the drawn circle's.
		const circle = node.querySelector('circle');
		return circle ? { x, y: Number(circle.getAttribute('cy')) } : null;
	}

	byNode(node: Element): MapNode | null {
		return this.nodes.find(n => n.node === node) ?? null;
	}

	byName(name: string): MapNode | null {
		return this.nodes.find(n => n.name === name) ?? null;
	}

	/** The node a line endpoint belongs to: the nearest centre within END_TOLERANCE (map px). */
	ownerAt(x: number, y: number): MapNode | null {
		let best: MapNode | null = null, dist = END_TOLERANCE;
		for (const n of this.nodes) {
			const d = Math.hypot(n.center.x - x, n.center.y - y);
			if (d <= dist) { best = n; dist = d; }
		}
		return best;
	}

	toSvg(clientX: number, clientY: number): Pt {
		const ctm = this.svg.getScreenCTM();
		const pt = this.svg.createSVGPoint();
		pt.x = clientX;
		pt.y = clientY;
		const p = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
		return { x: p.x, y: p.y };
	}

	/** SVG units to screen pixels (the CTM changes with scrolling, so it is read each time). */
	toScreen(x: number, y: number): Pt {
		const ctm = this.svg.getScreenCTM();
		const pt = this.svg.createSVGPoint();
		pt.x = x;
		pt.y = y;
		const p = ctm ? pt.matrixTransform(ctm) : pt;
		return { x: p.x, y: p.y };
	}

	/** Pipeline boxes in drawing order, which is the order of the `pipeline` lines. */
	pipelineBoxes(): { parent: string; box: Element }[] {
		const parents = pipelineParents(this.src);
		return Array.from(this.svg.querySelectorAll('rect.wardley-pipeline-box')).map((box, i) => ({ parent: parents[i], box }));
	}

	/** Elements that move with a pipeline parent: its box, its components and the line between them. */
	pipelineParts(parent: string): Element[] | null {
		let children: string[] | null = null;
		try { children = pipelineOf(this.src, parent); } catch { /* not closed */ }
		if (!children) return null;
		const parts: Element[] = [];
		const box = this.pipelineBoxes().find(b => b.parent === parent)?.box;
		if (box) parts.push(box);
		const centers: Pt[] = [];
		for (const n of this.nodes) {
			if (n.node.classList.contains('wardley-node--pipeline-component') && children.includes(n.name)) {
				parts.push(n.node);
				centers.push(n.center);
			}
		}
		// Only this pipeline's evolution links, not every pipeline's (review finding #13).
		const own = (x: string | null, y: string | null) => centers.some(c => Math.hypot(c.x - Number(x), c.y - Number(y)) <= END_TOLERANCE);
		this.svg.querySelectorAll('line.wardley-pipeline-evolution-link').forEach(l => {
			if (own(l.getAttribute('x1'), l.getAttribute('y1'))) parts.push(l);
		});
		return parts;
	}

	/** Link lines that start or end at this node (their ends sit on its rim). */
	linksAt(p: Pt): { el: SVGLineElement; end: 1 | 2; orig: Pt }[] {
		const near = (x: string | null, y: string | null) => Math.hypot(Number(x) - p.x, Number(y) - p.y) <= END_TOLERANCE;
		const out: { el: SVGLineElement; end: 1 | 2; orig: Pt }[] = [];
		this.svg.querySelectorAll<SVGLineElement>('line.wardley-link').forEach(el => {
			if (near(el.getAttribute('x1'), el.getAttribute('y1'))) out.push({ el, end: 1, orig: { x: Number(el.getAttribute('x1')), y: Number(el.getAttribute('y1')) } });
			else if (near(el.getAttribute('x2'), el.getAttribute('y2'))) out.push({ el, end: 2, orig: { x: Number(el.getAttribute('x2')), y: Number(el.getAttribute('y2')) } });
		});
		return out;
	}
}

/** The plot area, read from the two axis lines Mermaid draws first. */
function plotBox(svg: SVGSVGElement): Box | null {
	const [x, y] = Array.from(svg.querySelectorAll('g.wardley-axes > line'));
	if (!x || !y) return null;
	const n = (el: Element, a: string) => Number(el.getAttribute(a));
	const box = { left: n(x, 'x1'), right: n(x, 'x2'), bottom: n(x, 'y1'), top: n(y, 'y1') };
	return box.right > box.left && box.bottom > box.top ? box : null;
}
