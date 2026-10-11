import { FlowCluster, FlowEdge, FlowModel, FlowNode } from './flowchart-map';

/**
 * Gesture zones of the flowchart editor, in screen pixels. An edge is a 1-2 px curve, so it is
 * grabbed by distance: `width` off the path, its ends in a band of at most `end` (a third of a
 * short edge), its middle between. The "+" ring is a band just outside a node's box.
 */
export const EDGE_GRAB = { width: 6, end: 24 };
export const PLUS_BAND = 14;
/** A group's border, either side of its outline: grabs the group like its title does. */
export const BORDER_BAND = 5;
/** A finger is less precise than a mouse: zones grow by this factor for touch. */
export const TOUCH_SCALE = 2;
/** Length of the provisional stub a click in the ring draws, in SVG units. */
export const FLOW_STUB_LENGTH = 40;

/** What a press at a point means in a flowchart. */
export type FlowHit =
	| { kind: 'node'; node: FlowNode }
	| { kind: 'edge-label'; edge: FlowEdge }
	| { kind: 'edge-end'; edge: FlowEdge; end: 'from' | 'to' }
	| { kind: 'edge-middle'; edge: FlowEdge }
	| { kind: 'plus'; node: FlowNode }
	| { kind: 'cluster'; cluster: FlowCluster };

/**
 * Classifies a press at (x, y) on `target`, one priority order for press, touch start and hover
 * (the Wardley lesson, review finding #1): elements under the pointer first (an edge's label, a
 * node, a group's title), then the zones around thin edges (an end, the middle), then the "+" ring
 * around a node, then a group's border. A group's background is left to Obsidian (a click there
 * opens the source).
 */
export function classifyFlow(model: FlowModel, target: Element, x: number, y: number, touch = false): FlowHit | null {
	const k = touch ? TOUCH_SCALE : 1;
	const label = model.edgeOfLabel(target);
	if (label) return { kind: 'edge-label', edge: label };
	const node = model.nodeOf(target);
	if (node) return { kind: 'node', node };
	const cluster = model.clusterOfLabel(target);
	if (cluster) return { kind: 'cluster', cluster };
	const edge = edgeZone(model, x, y, EDGE_GRAB.width * k);
	if (edge) return edge;
	const ring = model.nodeAt(x, y, PLUS_BAND * k);
	if (ring && !model.nodeAt(x, y)) return { kind: 'plus', node: ring };
	const border = model.clusterBorderAt(x, y, BORDER_BAND * k);
	if (border) return { kind: 'cluster', cluster: border };
	return null;
}

function edgeZone(model: FlowModel, x: number, y: number, width: number): FlowHit | null {
	let best: { edge: FlowEdge; along: number; len: number; perp: number } | null = null;
	for (const edge of model.edges) {
		const h = model.edgeHit(edge, x, y);
		if (!h || h.perp > width || (best && h.perp >= best.perp)) continue;
		best = { edge, ...h };
	}
	if (!best) return null;
	const band = Math.min(EDGE_GRAB.end, best.len / 3);
	if (best.along <= band) return { kind: 'edge-end', edge: best.edge, end: 'from' };
	if (best.len - best.along <= band) return { kind: 'edge-end', edge: best.edge, end: 'to' };
	return { kind: 'edge-middle', edge: best.edge };
}
