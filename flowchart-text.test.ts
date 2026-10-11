// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { Arrow, SHAPES, scan } from './flowchart-scan';
import {
	EditError, addEdge, addGroup, addLinkedNode, addNode, arrowText, deleteEdge, deleteGroup, deleteNode, edgeInfo, getDirection, groupInfo,
	moveToGroup, newId, nodeInfo, relinkEdge, reverseEdge, setDirection, setEdge, setGroupDirection, setGroupTitle, setNodeColor, setNodeLabel,
	setNodeShape, ungroup,
} from './flowchart-text';
import { ALL, DEMO, REAL } from './flowchart.fixtures';
import { MermaidFlow, agrees, mermaidFlow, mermaidType } from './test-mermaid';

// The property tests run every edit on every element through Mermaid's parser: seconds, not ms.
vi.setConfig({ testTimeout: 60_000 });

const DIAGRAMS: [string, string][] = [['demo', DEMO], ['all elements', ALL], ...REAL.map((r, i) => [`real ${i}`, r] as [string, string])];

/** An edge as Mermaid reads it, without its generated id (which shifts when edges go). */
const edgeKey = (e: Pick<MermaidFlow['edges'][number], 'start' | 'end' | 'type' | 'stroke' | 'length' | 'text'>) => `${e.start}>${e.end}:${e.type}/${e.stroke}/${e.length}|${e.text.includes('<') ? '<html>' : e.text}`;
/** Which subgraph (by title) each node is in. */
const groups = (m: MermaidFlow) => {
	const out: Record<string, string> = {};
	for (const s of m.subgraphs) for (const n of s.nodes) out[n] = s.title;
	return out;
};
const vertexIds = (m: MermaidFlow) => m.vertices.map(v => v.id).sort();

describe.each(DIAGRAMS)('every edit on the %s diagram', (_name, src) => {
	it('deleting each edge removes exactly that edge, nothing else', async () => {
		const before = await mermaidFlow(src);
		for (let i = 0; i < before.edges.length; i++) {
			const next = deleteEdge(src, i);
			const after = await agrees(next).then(() => mermaidFlow(next));
			const expected = before.edges.filter((_e, j) => j !== i).map(edgeKey);
			expect([i, after.edges.map(edgeKey)]).toEqual([i, expected]);
			expect([i, vertexIds(after)]).toEqual([i, vertexIds(before)]);
			expect([i, groups(after)]).toEqual([i, groups(before)]);
		}
	});

	it('reversing each edge swaps its ends, nothing else', async () => {
		const before = await mermaidFlow(src);
		for (let i = 0; i < before.edges.length; i++) {
			const next = reverseEdge(src, i);
			const after = await agrees(next).then(() => mermaidFlow(next));
			const expected = before.edges.map((e, j) => edgeKey(j === i ? { ...e, start: e.end, end: e.start } : e));
			expect([i, after.edges.map(edgeKey)]).toEqual([i, expected]);
			expect([i, groups(after)]).toEqual([i, groups(before)]);
		}
	});

	it('restyling and relabelling each edge changes only that edge', async () => {
		const before = await mermaidFlow(src);
		const arrow: Arrow = { stroke: 'dotted', head: 'arrow', both: false, length: 1 };
		for (let i = 0; i < before.edges.length; i++) {
			const next = setEdge(src, i, arrow, 'new words');
			const after = await agrees(next).then(() => mermaidFlow(next));
			const expected = before.edges.map((e, j) => edgeKey(j === i ? { ...e, type: 'arrow_point', stroke: 'dotted', length: 1, text: 'new words' } : e));
			expect([i, after.edges.map(edgeKey)]).toEqual([i, expected]);
			expect([i, groups(after)]).toEqual([i, groups(before)]);
		}
	});

	it('deleting each node removes it and its edges, nothing else', async () => {
		const before = await mermaidFlow(src);
		const sg = new Set(before.subgraphs.map(s => s.id));
		for (const v of before.vertices) {
			if (sg.has(v.id)) continue;
			const next = deleteNode(src, v.id);
			const after = await agrees(next).then(() => mermaidFlow(next));
			const expected = before.edges.filter(e => e.start !== v.id && e.end !== v.id).map(edgeKey);
			expect([v.id, after.edges.map(edgeKey)]).toEqual([v.id, expected]);
			expect([v.id, vertexIds(after)]).toEqual([v.id, vertexIds(before).filter(id => id !== v.id)]);
			const g = groups(before);
			delete g[v.id];
			expect([v.id, groups(after)]).toEqual([v.id, g]);
		}
	});

	it('relabelling and reshaping each node changes only that node', async () => {
		const before = await mermaidFlow(src);
		const sg = new Set(before.subgraphs.map(s => s.id));
		for (const v of before.vertices) {
			if (sg.has(v.id)) continue;
			const labelled = setNodeLabel(src, v.id, 'Fresh (label)');
			const a = await agrees(labelled).then(() => mermaidFlow(labelled));
			expect([v.id, a.vertices.find(x => x.id === v.id)?.text]).toEqual([v.id, 'Fresh (label)']);
			expect([v.id, a.edges.map(edgeKey)]).toEqual([v.id, before.edges.map(edgeKey)]);
			const shaped = setNodeShape(src, v.id, 'hexagon');
			const b = await agrees(shaped).then(() => mermaidFlow(shaped));
			const type = b.vertices.find(x => x.id === v.id)?.type;
			expect([v.id, type]).toEqual([v.id, scan(src).nodes.get(v.id)!.some(n => n.meta) ? 'hex' : 'hexagon']);
			expect([v.id, groups(b)]).toEqual([v.id, groups(before)]);
		}
	});
});

describe('edges', () => {
	it('writes every arrow the way Mermaid reads it', async () => {
		for (const stroke of ['normal', 'thick', 'dotted'] as const) {
			for (const head of ['none', 'arrow', 'circle', 'cross'] as const) {
				for (const both of head === 'none' ? [false] : [false, true]) {
					for (const length of [1, 2, 3]) {
						const a: Arrow = { stroke, head, both, length };
						const m = await mermaidFlow(`flowchart LR\nA ${arrowText(a)} B`);
						expect([arrowText(a), m.edges[0].type, m.edges[0].stroke, m.edges[0].length]).toEqual([arrowText(a), mermaidType(a), stroke, length]);
					}
				}
			}
		}
		const inv = await mermaidFlow(`flowchart LR\nA ${arrowText({ stroke: 'invisible', head: 'none', both: false, length: 1 })} B`);
		expect(inv.edges[0].stroke).toBe('invisible');
	});

	it('reads what the dialog shows', () => {
		expect(edgeInfo('flowchart LR\nA -- go --> B', 0)).toEqual({ index: 0, from: 'A', to: 'B', arrow: { stroke: 'normal', head: 'arrow', both: false, length: 1 }, label: 'go' });
		expect(edgeInfo('flowchart LR\nA <-.->|"x y"| B', 0).arrow).toEqual({ stroke: 'dotted', head: 'arrow', both: true, length: 1 });
	});

	it('keeps an inline label inline and the arrow as written when only the words change', () => {
		const src = 'flowchart LR\n  A -- go --> B';
		expect(setEdge(src, 0, edgeInfo(src, 0).arrow, 'stop')).toBe('flowchart LR\n  A -- stop --> B');
		expect(setEdge('flowchart LR\n  A --->|go| B', 0, { stroke: 'normal', head: 'arrow', both: false, length: 2 }, 'stop')).toBe('flowchart LR\n  A --->|stop| B');
	});

	it('moves a label that is unsafe inline into pipes, quoted when it needs quotes', async () => {
		const src = 'flowchart LR\n  A -- go --> B';
		const next = setEdge(src, 0, edgeInfo(src, 0).arrow, 'a-b (c)');
		expect(next).toBe('flowchart LR\n  A -->|"a-b (c)"| B');
		expect((await mermaidFlow(next)).edges[0].text).toBe('a-b (c)');
	});

	it('removes and adds labels', () => {
		const a: Arrow = { stroke: 'normal', head: 'arrow', both: false, length: 1 };
		expect(setEdge('flowchart LR\nA -->|go| B', 0, a, '')).toBe('flowchart LR\nA --> B');
		expect(setEdge('flowchart LR\nA -- go --> B', 0, a, '')).toBe('flowchart LR\nA --> B');
		expect(setEdge('flowchart LR\nA --> B', 0, a, 'go')).toBe('flowchart LR\nA -->|go| B');
		expect(setEdge('flowchart LR\nA --> B', 0, a, '')).toBe('flowchart LR\nA --> B');
	});

	it('splits a chain only where it has to, keeping shapes and order', () => {
		const src = 'flowchart LR\n  A[Start] --> B{Check} --> C((End))';
		expect(deleteEdge(src, 0)).toBe('flowchart LR\n  A[Start]\n  B{Check} --> C((End))');
		expect(deleteEdge(src, 1)).toBe('flowchart LR\n  A[Start] --> B{Check}\n  C((End))');
		expect(setEdge(src, 1, { stroke: 'thick', head: 'arrow', both: false, length: 1 }, '')).toBe('flowchart LR\n  A[Start] --> B{Check} ==> C((End))');
	});

	it('expands an & group only for the edge it changes, user ids staying with their edge', async () => {
		const src = 'flowchart LR\n  A & B e1@--> C';
		const next = deleteEdge(src, 0);
		expect(next).toBe('flowchart LR\n  A\n  B e1@--> C');
		const m = await mermaidFlow(next);
		expect(m.edges.map(e => e.id)).toEqual(['e1']);
	});

	it('relinks either end, keeping the old node with its label', async () => {
		const src = 'flowchart LR\n  A --> B[Bee]\n  C';
		expect(relinkEdge(src, 0, 'to', 'C')).toBe('flowchart LR\n  A --> C\n  B[Bee]\n  C');
		expect(relinkEdge(src, 0, 'from', 'C')).toBe('flowchart LR\n  A\n  C --> B[Bee]\n  C');
		expect(() => relinkEdge(src, 0, 'to', 'A')).toThrow(EditError);
		expect(() => relinkEdge(src, 0, 'to', 'Nope')).toThrow(EditError);
	});

	it('adds an edge after every other one, refusing a duplicate', async () => {
		const src = 'flowchart LR\n  A --> B\n  subgraph S\n    B --> C\n  end\n  D\n  linkStyle 1 stroke:red';
		const next = addEdge(src, 'D', 'A');
		expect(next).toBe('flowchart LR\n  A --> B\n  subgraph S\n    B --> C\n  end\n  D --> A\n  D\n  linkStyle 1 stroke:red');
		expect((await mermaidFlow(next)).subgraphs[0].nodes.sort()).toEqual(['B', 'C']);
		expect(() => addEdge(src, 'A', 'B')).toThrow(/already/);
		expect(() => addEdge(src, 'A', 'A')).toThrow(EditError);
	});

	it('renumbers linkStyle when an edge before it goes or comes', () => {
		const src = 'flowchart LR\n  A --> B\n  B --> C\n  C --> D\n  linkStyle 0,2 stroke:red\n  linkStyle 1 stroke:blue';
		expect(deleteEdge(src, 1)).toBe('flowchart LR\n  A --> B\n  C --> D\n  linkStyle 0,1 stroke:red');
		expect(deleteEdge(src, 0)).toBe('flowchart LR\n  A\n  B --> C\n  C --> D\n  linkStyle 1 stroke:red\n  linkStyle 0 stroke:blue');
		expect(deleteNode(src, 'D')).toBe('flowchart LR\n  A --> B\n  B --> C\n  linkStyle 0 stroke:red\n  linkStyle 1 stroke:blue');
	});
});

describe('nodes', () => {
	it('reads what the dialog shows', () => {
		const info = nodeInfo(DEMO, 'Done');
		expect([info.label, info.shape, info.group, info.fill]).toEqual(['Done', 'circle', null, '#d3f9d8']);
		expect(nodeInfo(DEMO, 'Water').group?.title).toBe('Kitchen');
		expect(nodeInfo(ALL, 'N2')).toMatchObject({ label: 'Delay', meta: 'delay' });
		expect(nodeInfo('flowchart LR\nA --> B', 'B')).toMatchObject({ label: 'B', shape: null });
	});

	it('gives a bare node a label and a shape on its first mention', () => {
		expect(setNodeLabel('flowchart LR\n  A --> B\n  B --> C', 'B', 'Bee')).toBe('flowchart LR\n  A --> B[Bee]\n  B --> C');
		expect(setNodeShape('flowchart LR\n  A --> B', 'B', 'diamond')).toBe('flowchart LR\n  A --> B{B}');
	});

	it('changes every definition of a node, quoting where the text needs it', async () => {
		const src = 'flowchart LR\n  A[Old] --> B\n  A[Old] --> C';
		const next = setNodeLabel(src, 'A', 'He said "hi" (twice)');
		expect(next).toBe('flowchart LR\n  A["He said #quot;hi#quot; (twice)"] --> B\n  A["He said #quot;hi#quot; (twice)"] --> C');
		expect(setNodeShape(src, 'A', 'cylinder')).toBe('flowchart LR\n  A[(Old)] --> B\n  A[(Old)] --> C');
		expect(await mermaidFlow(next)).toBeTruthy();
	});

	it('keeps markdown labels markdown', async () => {
		const next = setNodeLabel('flowchart LR\n  A["`**b**`"]', 'A', '*it*');
		expect(next).toBe('flowchart LR\n  A["`*it*`"]');
	});

	it('every shape survives a label with brackets and slashes', async () => {
		for (const sh of SHAPES) {
			const src = setNodeShape('flowchart LR\n  A["a/b (c) [d]"] --> B', 'A', sh.type);
			const m = await mermaidFlow(src);
			expect([sh.type, m.vertices[0].type, m.vertices[0].text]).toEqual([sh.type, sh.type, 'a/b (c) [d]']);
		}
	});

	it('edits the @{ } syntax in place', async () => {
		const src = 'flowchart LR\n  A@{ shape: doc, label: "Doc" } --> B\n  C@{ shape: cyl }';
		expect(setNodeLabel(src, 'A', 'Paper')).toBe('flowchart LR\n  A@{ shape: doc, label: "Paper" } --> B\n  C@{ shape: cyl }');
		expect(setNodeLabel(src, 'C', 'Disk')).toBe('flowchart LR\n  A@{ shape: doc, label: "Doc" } --> B\n  C@{ shape: cyl, label: "Disk" }');
		const multi = 'flowchart LR\n  A@{\n    shape: doc\n  }';
		expect(setNodeLabel(multi, 'A', 'Paper')).toBe('flowchart LR\n  A@{\n    shape: doc\n    label: "Paper"\n  }');
		expect((await mermaidFlow(setNodeShape(src, 'A', 'diamond'))).vertices[0].type).toBe('diam');
	});

	it('deletes a node with its style, click and class entries', async () => {
		const src = 'flowchart LR\n  A --> B\n  style B fill:#f00\n  click B "https://example.com"\n  class A,B hot\n  classDef hot fill:#ff0';
		expect(deleteNode(src, 'B')).toBe('flowchart LR\n  A\n  class A hot\n  classDef hot fill:#ff0');
	});

	it('refuses a node that is not there or is a subgraph', () => {
		expect(() => deleteNode(DEMO, 'Nope')).toThrow(EditError);
		expect(() => deleteNode('flowchart LR\n  subgraph S\n    A\n  end\n  S --> B', 'S')).toThrow(/subgraph/);
	});
});

describe('adding', () => {
	it('derives a readable, unused id from the label', () => {
		const flow = scan('flowchart LR\n  CheckStock --> B');
		expect(newId(flow, 'Check stock')).toBe('CheckStock2');
		expect(newId(flow, 'Größe prüfen')).toBe('GroessePruefen');
		expect(newId(flow, '42 things')).toBe('N42Things');
		expect(newId(flow, 'end')).toBe('End');
		expect(newId(flow, '!!!')).toBe('Node');
	});

	it('adds a node with a shape after the last statement', async () => {
		const next = addNode('flowchart LR\n  A --> B\n  style A fill:#f00', 'Is it ready?', 'diamond');
		expect(next).toBe('flowchart LR\n  A --> B\n  IsItReady{Is it ready?}\n  style A fill:#f00');
		expect((await mermaidFlow(next)).vertices.map(v => [v.id, v.type])).toContainEqual(['IsItReady', 'diamond']);
	});

	it('adds a linked node at the top level, or inside the subgraph of its source', async () => {
		expect(addLinkedNode('flowchart LR\n  A --> B', 'B', 'Next')).toBe('flowchart LR\n  A --> B\n  B --> Next[Next]');
		const src = 'flowchart LR\n  subgraph K [Kitchen]\n    Brew --> Water\n  end\n  Water --> Cup\n  linkStyle 1 stroke:red';
		const next = addLinkedNode(src, 'Water', 'Kettle', 'round');
		expect(next).toBe('flowchart LR\n  subgraph K [Kitchen]\n    Brew --> Water\n    Water --> Kettle(Kettle)\n  end\n  Water --> Cup\n  linkStyle 2 stroke:red');
		const m = await mermaidFlow(next);
		expect(m.subgraphs[0].nodes.sort()).toEqual(['Brew', 'Kettle', 'Water']);
		expect(m.edges.map(e => `${e.start}>${e.end}`)).toEqual(['Brew>Water', 'Water>Kettle', 'Water>Cup']);
	});

	it('sets the direction', () => {
		expect(setDirection('flowchart TD\n  A', 'LR')).toBe('flowchart LR\n  A');
		expect(setDirection('graph\n  A', 'RL')).toBe('graph RL\n  A');
		expect(getDirection('flowchart BT\n  A')).toBe('BT');
		expect(getDirection('flowchart\n  A')).toBe('TB');
	});
});

describe('colours', () => {
	const c = { fill: '#fde2c8', stroke: '#d9822b', color: '#1f2933' };
	it('adds, replaces and removes a node colour, keeping other style properties', async () => {
		const added = setNodeColor('flowchart LR\n  A --> B', 'B', c);
		expect(added).toBe('flowchart LR\n  A --> B\n  style B fill:#fde2c8,stroke:#d9822b,color:#1f2933');
		const kept = setNodeColor('flowchart LR\n  A --> B\n  style B fill:#000,stroke-dasharray: 4 4', 'B', c);
		expect(kept).toBe('flowchart LR\n  A --> B\n  style B fill:#fde2c8,stroke:#d9822b,color:#1f2933,stroke-dasharray: 4 4');
		expect(setNodeColor(kept, 'B', null)).toBe('flowchart LR\n  A --> B\n  style B stroke-dasharray: 4 4');
		expect(setNodeColor(added, 'B', null)).toBe('flowchart LR\n  A --> B');
		expect(await mermaidFlow(kept)).toBeTruthy();
	});
});

/** The edges each `linkStyle` statement styles, as Mermaid reads them (start>end:type). */
async function styled(src: string): Promise<string[]> {
	const m = await mermaidFlow(src);
	const out: string[] = [];
	for (const line of src.split('\n')) {
		const ls = /^\s*linkStyle\s+([\d,]+)\s+(.*)$/.exec(line);
		if (!ls) continue;
		for (const i of ls[1].split(',').map(Number)) {
			const e = m.edges[i];
			out.push(e ? `${e.start}>${e.end}:${e.type} ${ls[2]}` : `missing ${i}`);
		}
	}
	return out.sort();
}

describe.each(DIAGRAMS)('every group edit on the %s diagram', (_name, src) => {
	it('moves each node into each group and out again, nothing else changing', async () => {
		const before = await mermaidFlow(src);
		const style = await styled(src);
		const sg = new Set(before.subgraphs.map(s => s.id));
		const targets: (string | null)[] = [null, ...before.subgraphs.map(s => s.id)];
		for (const v of before.vertices) {
			if (sg.has(v.id)) continue;
			for (const t of targets) {
				const next = moveToGroup(src, v.id, t);
				const after = await agrees(next).then(() => mermaidFlow(next));
				const g = groups(before);
				if (t === null) delete g[v.id];
				else g[v.id] = before.subgraphs.find(s => s.id === t)!.title;
				expect([v.id, t, groups(after)]).toEqual([v.id, t, g]);
				expect([v.id, t, after.edges.map(edgeKey).sort()]).toEqual([v.id, t, before.edges.map(edgeKey).sort()]);
				expect([v.id, t, vertexIds(after)]).toEqual([v.id, t, vertexIds(before)]);
				expect([v.id, t, await styled(next)]).toEqual([v.id, t, style]);
				expect([v.id, t, after.vertices.find(x => x.id === v.id)]).toEqual([v.id, t, v]);
			}
		}
	});

	it('puts each node into a new group of its own', async () => {
		const before = await mermaidFlow(src);
		const sg = new Set(before.subgraphs.map(s => s.id));
		for (const v of before.vertices) {
			if (sg.has(v.id)) continue;
			const next = addGroup(src, 'Fresh group', v.id);
			const after = await agrees(next).then(() => mermaidFlow(next));
			const g = groups(before);
			// A group nested in the node's old group is listed by Mermaid as a member of that group.
			const fresh = after.subgraphs.find(x => x.title === 'Fresh group')!.id;
			if (g[v.id]) g[fresh] = g[v.id];
			g[v.id] = 'Fresh group';
			expect([v.id, groups(after)]).toEqual([v.id, g]);
			expect([v.id, after.edges.map(edgeKey)]).toEqual([v.id, before.edges.map(edgeKey)]);
		}
	});

	it('retitles, redirects, dissolves and deletes each group', async () => {
		const before = await mermaidFlow(src);
		const style = await styled(src);
		for (const s of before.subgraphs) {
			const titled = setGroupTitle(src, s.id, 'New (title)');
			const t = await agrees(titled).then(() => mermaidFlow(titled));
			expect([s.id, t.subgraphs.map(x => x.title).sort()]).toEqual([s.id, before.subgraphs.map(x => (x.id === s.id ? 'New (title)' : x.title)).sort()]);
			expect([s.id, groups(t)]).toEqual([s.id, Object.fromEntries(Object.entries(groups(before)).map(([k, v]) => [k, v === s.title ? 'New (title)' : v]))]);

			const lr = setGroupDirection(src, s.id, 'RL');
			await agrees(lr);
			expect(groupInfo(lr, s.id).direction).toBe('RL');
			const none = setGroupDirection(lr, s.id, null);
			expect(groupInfo(none, s.id).direction).toBeNull();
			expect(await mermaidFlow(none)).toBeTruthy();

			let dissolved: string | null = null;
			try { dissolved = ungroup(src, s.id); } catch (e) { expect(e).toBeInstanceOf(EditError); }
			if (dissolved !== null) {
				const u = await agrees(dissolved).then(() => mermaidFlow(dissolved!));
				expect([s.id, u.subgraphs.map(x => x.id)]).toEqual([s.id, before.subgraphs.map(x => x.id).filter(x => x !== s.id)]);
				expect([s.id, u.edges.map(edgeKey)]).toEqual([s.id, before.edges.map(edgeKey)]);
				expect([s.id, await styled(dissolved)]).toEqual([s.id, style]);
			}

			const deleted = deleteGroup(src, s.id);
			const d = await agrees(deleted).then(() => mermaidFlow(deleted));
			const inner = new Set<string>([s.id]);
			let grew = true;
			while (grew) { grew = false; for (const x of before.subgraphs) if (!inner.has(x.id) && before.subgraphs.some(y => inner.has(y.id) && y.nodes.includes(x.id))) { inner.add(x.id); grew = true; } }
			const gone = new Set([...inner, ...before.subgraphs.filter(x => inner.has(x.id)).flatMap(x => x.nodes)]);
			expect([s.id, d.edges.map(edgeKey)]).toEqual([s.id, before.edges.filter(e => !gone.has(e.start) && !gone.has(e.end)).map(edgeKey)]);
			expect([s.id, vertexIds(d)]).toEqual([s.id, vertexIds(before).filter(id => !gone.has(id))]);
		}
	});
});

describe('groups', () => {
	it('moves a statement with edges out of its group behind every edge, linkStyle following', async () => {
		const src = 'flowchart LR\n  subgraph K [Kitchen]\n    A --> B\n    B --> C\n  end\n  C --> D\n  linkStyle 0 stroke:red';
		const next = moveToGroup(src, 'A', null);
		expect(next).toBe('flowchart LR\n  subgraph K [Kitchen]\n    B --> C\n  end\n  C --> D\n  A --> B\n  linkStyle 2 stroke:red');
		const m = await mermaidFlow(next);
		expect(m.subgraphs[0].nodes.sort()).toEqual(['B', 'C']);
	});

	it('carries a node\'s shape into its new group', () => {
		const src = 'flowchart LR\n  subgraph K [Kitchen]\n    A[(Water)]\n  end\n  subgraph S [Shop]\n    B\n  end\n  A --> B';
		expect(moveToGroup(src, 'A', 'S')).toBe('flowchart LR\n  subgraph K [Kitchen]\n  end\n  subgraph S [Shop]\n    B\n    A[(Water)]\n  end\n  A --> B');
	});

	it('refuses to dissolve a group that edges point at', () => {
		expect(() => ungroup('flowchart LR\n  subgraph S\n    A\n  end\n  S --> B', 'S')).toThrow(/refer/);
	});

	it('nests a new group inside the node\'s group', async () => {
		const next = addGroup(DEMO, 'Heating', 'Water');
		expect(next).toContain('    Water ==> Cup[[Pour into cup]]\n    subgraph Heating [Heating]\n      Water\n    end\n  end');
		const m = await mermaidFlow(next);
		expect(m.subgraphs.find(s => s.id === 'Heating')?.nodes).toEqual(['Water']);
	});

	it('keeps a group written `subgraph Name` named by its id when retitled', async () => {
		const next = setGroupTitle('flowchart LR\n  subgraph Kitchen\n    A\n  end\n  Kitchen --> B', 'Kitchen', 'The kitchen');
		expect(next).toBe('flowchart LR\n  subgraph Kitchen [The kitchen]\n    A\n  end\n  Kitchen --> B');
		expect((await mermaidFlow(next)).subgraphs[0]).toMatchObject({ id: 'Kitchen', title: 'The kitchen' });
	});
});

describe('code review 0.18.0: every case found is either right or refused', () => {
	it.each(DIAGRAMS)('relinking any end of any edge to any node of the %s diagram changes only that edge', async (_name, src) => {
		const before = await mermaidFlow(src);
		const sg = new Set(before.subgraphs.map(s => s.id));
		const all = before.vertices.map(v => v.id).filter(id => !sg.has(id));
		// Every edge and end, every k-th node: about 400 re-links per diagram keep the suite fast.
		const k = Math.max(1, Math.ceil((before.edges.length * 2 * all.length) / 400));
		const nodes = all.filter((_id, i) => i % k === 0);
		let written = 0, refused = 0;
		for (let i = 0; i < before.edges.length; i++) {
			for (const end of ['from', 'to'] as const) {
				for (const id of nodes) {
					const e = before.edges[i];
					if ((end === 'from' ? e.end : e.start) === id || (end === 'from' ? e.start : e.end) === id) continue;
					let next: string;
					try { next = relinkEdge(src, i, end, id); } catch (err) { expect(err).toBeInstanceOf(EditError); refused++; continue; }
					written++;
					const after = await mermaidFlow(next);
					const want = before.edges.map((x, j) => edgeKey(j === i ? { ...x, [end === 'from' ? 'start' : 'end']: id } : x)).sort();
					expect([i, end, id, after.edges.map(edgeKey).sort()]).toEqual([i, end, id, want]);
					expect([i, end, id, groups(after)]).toEqual([i, end, id, groups(before)]);
					const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
					expect([i, end, id, [...after.vertices].sort(byId)]).toEqual([i, end, id, [...before.vertices].sort(byId)]);
				}
			}
		}
		// The point is that every write is right; refusals must stay the exception.
		expect(refused).toBeLessThan(written / 10 + 1);
		process.stdout.write(`relink sweep ${_name}: ${written} written, ${refused} refused\n`);
	});

	it('keeps a node in its own group when a link inside another group is moved to it', async () => {
		const src = 'flowchart LR\n  subgraph S\n    A --> B\n  end\n  subgraph T\n    C\n  end\n  linkStyle 0 stroke:red';
		const next = relinkEdge(src, 0, 'to', 'C');
		const m = await mermaidFlow(next);
		expect(m.subgraphs.map(s => [s.id, s.nodes.sort()])).toEqual(expect.arrayContaining([['S', ['A', 'B']], ['T', ['C']]]));
		expect(m.edges.map(e => `${e.start}>${e.end}`)).toEqual(['A>C']);
		expect(next).toContain('linkStyle 0 stroke:red');
	});

	it.each([
		['flowchart LR\n  A --new --> B', 'offer'],
		['flowchart LR\n  A --new --> B', 'xylophone'],
		['flowchart LR\n  A -- old--> B', 'Info'],
		['flowchart LR\n  A -.old.-> B', 'demo'],
		['flowchart LR\n  A ==new==> B', 'box'],
	])('changes only the words of the inline label in %j to %j', async (src, words) => {
		const before = (await mermaidFlow(src)).edges[0];
		const next = setEdge(src, 0, edgeInfo(src, 0).arrow, words);
		const after = await mermaidFlow(next);
		expect(after.edges).toHaveLength(1);
		expect(after.edges[0]).toMatchObject({ start: 'A', end: 'B', type: before.type, stroke: before.stroke, length: before.length, text: words });
	});

	it('refuses text Mermaid would read as a direction statement', () => {
		const src = 'flowchart LR\n  A --> B\n  subgraph S\n    C\n  end';
		expect(() => setNodeLabel(src, 'A', 'go direction LR')).toThrow(/direction/);
		expect(() => setEdge(src, 0, edgeInfo(src, 0).arrow, 'turn direction TB')).toThrow(/direction/);
		expect(() => addNode(src, 'direction RL', 'square')).toThrow(/direction/);
		expect(() => setGroupTitle(src, 'S', 'direction BT')).toThrow(/direction/);
		expect(setNodeLabel(src, 'A', 'direction: LR')).toContain('A[direction: LR]');
	});

	it('moves a node between groups without changing which definition of another node wins', async () => {
		const cases: [string, string, string | null][] = [
			['flowchart LR\n  subgraph S\n    A --> B[Bee]\n  end\n  B[Other]', 'A', null],
			['flowchart LR\n  subgraph T\n    X\n  end\n  A[One]\n  subgraph U\n    A[Two]\n  end', 'A', 'T'],
			['flowchart LR\n  subgraph S\n    A[One]\n  end\n  A[Two]', 'A', null],
		];
		for (const [src, id, to] of cases) {
			const before = await mermaidFlow(src);
			let next: string;
			try { next = moveToGroup(src, id, to); } catch (err) { expect(err).toBeInstanceOf(EditError); continue; }
			const after = await mermaidFlow(next);
			expect([src, after.vertices.map(v => [v.id, v.text]).sort()]).toEqual([src, before.vertices.map(v => [v.id, v.text]).sort()]);
			expect(groups(after)[id] ?? null).toBe(to === null ? null : before.subgraphs.find(s => s.id === to)!.title);
		}
	});

	it('retitles a group with a generated id without touching a node of the new name', async () => {
		const src = 'flowchart LR\n  subgraph My kitchen\n    A\n  end\n  B --> Shop';
		const next = setGroupTitle(src, 'subGraph0', 'Shop');
		const m = await mermaidFlow(next);
		expect(m.subgraphs.map(s => [s.title, s.nodes])).toEqual([['Shop', ['A']]]);
		expect(m.edges.map(e => `${e.start}>${e.end}`)).toEqual(['B>Shop']);
		expect(m.subgraphs[0].id).not.toBe('Shop');
		const named = 'flowchart LR\n  subgraph My kitchen\n    A\n  end\n  style subGraph0 fill:#eee';
		expect(setGroupTitle(named, 'subGraph0', 'Kitchen')).toContain('subgraph subGraph0 [Kitchen]');
	});

	it('inserts after a statement, not after what shares its line', async () => {
		const src = 'flowchart LR\n  A --> B; subgraph S\n    C\n  end\n  D';
		const next = addEdge(src, 'A', 'D');
		const m = await mermaidFlow(next);
		expect(m.subgraphs[0].nodes).toEqual(['C']);
		const one = 'flowchart LR\n  subgraph S; A --> B; end';
		const dir = setGroupDirection(one, 'S', 'LR');
		const d = await mermaidFlow(dir);
		expect(d.edges.map(e => `${e.start}>${e.end}`)).toEqual(['A>B']);
		expect(groupInfo(dir, 'S').direction).toBe('LR');
	});

	it('dissolves a group into its parent or refuses', async () => {
		const src = 'flowchart LR\n  subgraph S\n    A\n  end\n  subgraph T\n    A --> B\n  end';
		let next: string | null = null;
		try { next = ungroup(src, 'S'); } catch (err) { expect(err).toBeInstanceOf(EditError); }
		if (next !== null) expect(groups(await mermaidFlow(next)).A).toBeUndefined();
	});

	it('edits a flowchart with edge metadata', async () => {
		const src = 'flowchart LR\n  A e1@--> B\n  e1@{ animate: true }';
		const next = setNodeLabel(src, 'B', 'Bee');
		expect(next).toBe('flowchart LR\n  A e1@--> B[Bee]\n  e1@{ animate: true }');
		expect((await mermaidFlow(next)).edges[0].id).toBe('e1');
	});
});
