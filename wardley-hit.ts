import { segmentHit } from './geometry';
import { DROP_RADIUS, FORCE_NAME_OFFSET, LINK_GRAB, PLUS_RING, Pt, TIP_RADIUS, linkPart, onTrendShaft } from './wardley-geometry';
import { MapModel, MapNode } from './wardley-map';
import { ForceKind } from './wardley-text';

/** What a press at a point means. Each kind is one gesture or action in the editor. */
export type Hit =
	| { kind: 'note'; el: SVGTextElement; text: string }
	| { kind: 'force'; force: ForceKind; name: string; parts: Element[]; origin: Pt }
	/** A numbered annotation circle, or the box listing the texts (`number`: the line pressed, if any). */
	| { kind: 'annotation'; part: Element; box: boolean; number: number | null; origin: Pt }
	| { kind: 'inertia'; bar: SVGLineElement; name: string }
	| { kind: 'node'; node: MapNode; label: SVGTextElement | null }
	| { kind: 'trend-tip'; line: SVGLineElement; name: string }
	| { kind: 'trend-shaft'; name: string }
	| { kind: 'link-end'; line: SVGLineElement; end: 1 | 2; names: [string, string] }
	| { kind: 'link-middle'; names: [string, string] }
	| { kind: 'plus'; node: MapNode }
	| { kind: 'box'; node: MapNode };

/**
 * Classifies a press at (x, y) on `target`. **The one priority order**, shared by press,
 * touch-start and hover (review finding #1: zones were checked before the element under the
 * pointer, so a click on a component could delete another component's evolve arrow):
 *
 * 1. elements under the pointer: annotation (circle or box), note, accelerator/deaccelerator,
 *    inertia bar, node or label;
 * 2. zones around thin lines: evolve tip, evolve shaft, link end, link middle;
 * 3. the "+" ring around a node; 4. a pipeline box (stands for its parent).
 *
 * Inside a pipeline box the link zones need a precise hit and the ring is off, so the box
 * stays grabbable between the many links to its parent.
 */
export function classify(model: MapModel, target: Element, x: number, y: number): Hit | null {
	const p = { x, y };
	return elementHit(model, target)
		?? trendHit(model, p)
		?? linkHit(model, p, target.closest('rect.wardley-pipeline-box') ? LINK_GRAB.precise : LINK_GRAB.width)
		?? (target.closest('rect.wardley-pipeline-box') ? null : plusHit(model, p))
		?? boxHit(model, target);
}

function elementHit(model: MapModel, target: Element): Hit | null {
	const annotation = annotationHit(target);
	if (annotation) return annotation;
	const note = target.closest<SVGTextElement>('g.wardley-notes > text');
	if (note) return { kind: 'note', el: note, text: note.textContent ?? '' };
	const group = target.closest('g.wardley-accelerators, g.wardley-deaccelerators');
	if (group) {
		const children = Array.from(group.children);
		const at = children.findIndex(c => c === target || c.contains(target));
		// Mermaid appends each one as a path followed by its name.
		const path = children[at - (at % 2)], text = children[at - (at % 2) + 1];
		if (at >= 0 && path && text) {
			return {
				kind: 'force',
				force: group.classList.contains('wardley-accelerators') ? 'accelerator' : 'deaccelerator',
				name: text.textContent?.trim() ?? '',
				parts: [path, text],
				origin: { x: Number(text.getAttribute('x')) - FORCE_NAME_OFFSET, y: Number(text.getAttribute('y')) - FORCE_NAME_OFFSET },
			};
		}
	}
	const g = target.closest<SVGGElement>('g.wardley-node');
	const node = g ? model.byNode(g) : null;
	if (!g || !node) return null;
	// The inertia bar is drawn inside its node's group, on the evolve arrow's shaft.
	const bar = target.closest<SVGLineElement>('line.wardley-inertia');
	if (bar) return { kind: 'inertia', bar, name: node.name };
	// The standard has label offsets for components and pipeline components only.
	const label = target.closest<SVGTextElement>('text.wardley-node-label');
	const offsettable = g.classList.contains('wardley-node--component') || g.classList.contains('wardley-node--pipeline-component');
	return { kind: 'node', node, label: label && offsettable ? label : null };
}

/** Mermaid draws annotations last, so they lie on top of everything else. */
function annotationHit(target: Element): Hit | null {
	const circle = target.closest('g.wardley-annotation');
	if (circle) {
		const c = circle.querySelector('circle');
		const number = Number(circle.textContent?.trim());
		if (!c || !Number.isInteger(number)) return null;
		return { kind: 'annotation', part: circle, box: false, number, origin: { x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) } };
	}
	const box = target.closest('g.wardley-annotations-box');
	const rect = box?.querySelector('rect');
	if (!box || !rect) return null;
	// Each line reads `N. text`; the rectangle around them has no number.
	const line = /^(\d+)\./.exec(target.closest('text')?.textContent ?? '');
	return { kind: 'annotation', part: box, box: true, number: line ? Number(line[1]) : null, origin: { x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')) } };
}

function trendHit(model: MapModel, p: Pt): Hit | null {
	const lines = Array.from(model.svg.querySelectorAll<SVGLineElement>('line.wardley-trend')).map(line => ({
		line,
		owner: model.ownerAt(Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))),
		a: model.toScreen(Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))),
		b: model.toScreen(Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))),
	})).filter(t => t.owner);
	// Tips first, across all arrows: a tip may lie on another arrow's shaft.
	let tip: (typeof lines)[number] | null = null, dist = TIP_RADIUS;
	for (const t of lines) {
		const d = Math.hypot(t.b.x - p.x, t.b.y - p.y);
		if (d <= dist) { tip = t; dist = d; }
	}
	if (tip) return { kind: 'trend-tip', line: tip.line, name: tip.owner!.name };
	for (const t of lines) {
		const h = segmentHit(t.a, t.b, p);
		if (h && onTrendShaft(h.along, h.len, h.perp)) return { kind: 'trend-shaft', name: t.owner!.name };
	}
	return null;
}

function linkHit(model: MapModel, p: Pt, width: number): Hit | null {
	let best: { line: SVGLineElement; part: 1 | 2 | 'middle'; perp: number } | null = null;
	for (const line of Array.from(model.svg.querySelectorAll<SVGLineElement>('line.wardley-link'))) {
		const a = model.toScreen(Number(line.getAttribute('x1')), Number(line.getAttribute('y1')));
		const b = model.toScreen(Number(line.getAttribute('x2')), Number(line.getAttribute('y2')));
		const h = segmentHit(a, b, p);
		if (!h || h.perp > width || (best && h.perp >= best.perp)) continue;
		const part = linkPart(h.along, h.len);
		if (part) best = { line, part, perp: h.perp };
	}
	if (!best) return null;
	const l = best.line;
	const n1 = model.ownerAt(Number(l.getAttribute('x1')), Number(l.getAttribute('y1')));
	const n2 = model.ownerAt(Number(l.getAttribute('x2')), Number(l.getAttribute('y2')));
	if (!n1 || !n2) return null;
	const names: [string, string] = [n1.name, n2.name];
	return best.part === 'middle' ? { kind: 'link-middle', names } : { kind: 'link-end', line: l, end: best.part, names };
}

function plusHit(model: MapModel, p: Pt): Hit | null {
	let best: MapNode | null = null, dist = Infinity;
	for (const n of model.nodes) {
		const s = model.toScreen(n.center.x, n.center.y);
		const d = Math.hypot(s.x - p.x, s.y - p.y);
		if (d >= PLUS_RING.from && d <= PLUS_RING.to && d < dist) { best = n; dist = d; }
	}
	return best ? { kind: 'plus', node: best } : null;
}

function boxHit(model: MapModel, target: Element): Hit | null {
	const box = target.closest('rect.wardley-pipeline-box');
	if (!box) return null;
	const parent = model.pipelineBoxes().find(b => b.box === box)?.parent;
	const node = model.nodes.find(n => n.name === parent && n.node.classList.contains('wardley-node--component'));
	return node ? { kind: 'box', node } : null;
}

/** The node whose centre is within DROP_RADIUS screen pixels of the pointer. */
export function dropTargetAt(model: MapModel, x: number, y: number): MapNode | null {
	let best: MapNode | null = null, dist = DROP_RADIUS;
	for (const n of model.nodes) {
		const s = model.toScreen(n.center.x, n.center.y);
		const d = Math.hypot(s.x - x, s.y - y);
		if (d <= dist) { best = n; dist = d; }
	}
	return best;
}

/** A node (or a pipeline box standing for its parent) under the target, for armed legend actions. */
export function componentAt(model: MapModel, target: Element): MapNode | null {
	const g = target.closest<SVGGElement>('g.wardley-node');
	if (g) return model.byNode(g);
	const hit = boxHit(model, target);
	return hit && hit.kind === 'box' ? hit.node : null;
}

