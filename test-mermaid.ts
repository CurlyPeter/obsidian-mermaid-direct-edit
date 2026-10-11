/**
 * Test helper: Mermaid's own flowchart parser (the JISON one inside `mermaid`), so the
 * scanner and every edit are checked against what Mermaid reads. Needs a DOM for Mermaid's
 * sanitizer: test files using it start with `// @vitest-environment happy-dom`. Not bundled
 * (nothing in the plugin imports it).
 */
import mermaid from 'mermaid';
import { expect } from 'vitest';
import { Arrow, Flow, scan } from './flowchart-scan';

export interface MermaidFlow {
	direction: string;
	vertices: { id: string; text: string; type: string | undefined }[];
	edges: { id: string; start: string; end: string; type: string; stroke: string; length: number; text: string }[];
	subgraphs: { id: string; title: string; nodes: string[] }[];
}

/** What Mermaid reads from a flowchart source; throws its parse error. */
export async function mermaidFlow(src: string): Promise<MermaidFlow> {
	await mermaid.parse(src);
	const d = await mermaid.mermaidAPI.getDiagramFromText(src);
	const db = d.db as any;
	return {
		direction: db.getDirection(),
		vertices: [...db.getVertices().values()].map((v: any) => ({ id: v.id, text: v.text, type: v.type })),
		edges: db.getEdges().map((e: any) => ({ id: e.id, start: e.start, end: e.end, type: e.type, stroke: e.stroke, length: e.length, text: e.text })),
		subgraphs: db.getSubGraphs().map((s: any) => ({ id: s.id, title: s.title, nodes: [...s.nodes] })),
	};
}

/** Whether Mermaid parses `src`. */
export async function parses(src: string): Promise<boolean> {
	try {
		await mermaid.parse(src);
		return true;
	} catch {
		return false;
	}
}

/** Mermaid's edge type for an arrow (`destructLink`). */
export const mermaidType = (a: Arrow) =>
	(a.both && a.head !== 'none' ? 'double_' : '') + { none: 'arrow_open', arrow: 'arrow_point', circle: 'arrow_circle', cross: 'arrow_cross' }[a.head];

/** The label and shape that win for a node: Mermaid keeps the last definition. */
function effective(flow: Flow, id: string): { text: string; type: string | undefined } {
	let text = id, type: string | undefined;
	for (const n of flow.nodes.get(id) ?? []) {
		if (n.shape) { text = n.shape.label.text; type = n.shape.type; }
	}
	return { text, type };
}

/** The scan agrees with Mermaid on everything the editor relies on. */
export async function agrees(src: string) {
	const flow = scan(src);
	const m = await mermaidFlow(src);
	const sgIds = new Set(m.subgraphs.map(s => s.id));
	expect(flow.edges.map(e => [e.id, e.from.id, e.to.id])).toEqual(m.edges.map(e => [e.id, e.start, e.end]));
	// happy-dom's sanitizer mangles text around HTML such as <br/>; such labels are compared as one token.
	const norm = (t: string) => (t.includes('<') ? '<html>' : t);
	expect(flow.edges.map(e => {
		const l = e.chain.links[e.link];
		return [mermaidType(l.arrow), l.arrow.stroke, l.arrow.length, norm(l.label?.label.text ?? '')];
	})).toEqual(m.edges.map((e, i) => [e.type, e.stroke, e.length, flow.edges[i]?.chain.links[flow.edges[i].link].label?.label.text.includes('<') ? '<html>' : e.text]));
	expect([...flow.vertexIds].sort()).toEqual(m.vertices.map(v => v.id).filter(id => !sgIds.has(id)).sort());
	expect(flow.subgraphs.map(s => [s.id, s.title]).sort()).toEqual(m.subgraphs.map(s => [s.id, s.title]).sort());
	for (const s of m.subgraphs) {
		const mine = [...flow.memberOf].filter(([, sg]) => sg.id === s.id).map(([id]) => id).sort();
		expect([s.id, mine]).toEqual([s.id, s.nodes.filter(n => !sgIds.has(n)).sort()]);
	}
	for (const v of m.vertices) {
		if (sgIds.has(v.id) || !flow.nodes.get(v.id)?.some(n => n.shape)) continue;
		// happy-dom's sanitizer drops text before a <br/>; the type still has to match.
		const mine = effective(flow, v.id);
		if (norm(mine.text) !== mine.text) expect([v.id, mine.type]).toEqual([v.id, v.type]);
		else expect([v.id, mine]).toEqual([v.id, { text: v.text, type: v.type }]);
	}
	return flow;
}
