// @vitest-environment happy-dom
/**
 * Groups on Wardley maps (`%% group <name> <members>`, DEV.md → "Groups for wardley-beta"): the
 * line parser, the edits that keep the lines in step (checked by the real Mermaid parser and read
 * back through the model), the boundary geometry by its properties, and the drawing on an SVG
 * Mermaid produced.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import type { Pt } from './wardley-geometry';
import { GROUP_BUDGET, GROUP_RADIUS, inside, outline, pathOf, skeleton, type Segment } from './wardley-groups';
import { readModel } from './wardley-model';
import { applyGroups, wardleyRender } from './wardley-render';
import { deleteElement, deletePipeline, groupMarkers, groupsOf, rename } from './wardley-text';
import { SOURCE, SVG } from './wardley.fixtures';

const MAP = [
	'wardley-beta',
	'anchor Public [0.95, 0.62]',
	'component Cup of Tea [0.79, 0.61]',
	'component Cup [0.73, 0.80]',
	'component Tea [0.63, 0.83]',
	'component Staff [0.70, 0.40]',
	'component Kettle [0.30, 0.40]',
	'component Power [0.10, 0.70]',
	'',
	'Public -> Cup of Tea',
	'Cup of Tea -> Cup',
	'Cup of Tea -> Tea',
	'Cup of Tea -> Staff',
	'Kettle -> Power',
	'',
	'pipeline Kettle {',
	'  component Campfire Kettle [0.15]',
	'  component Electric Kettle [0.62]',
	'}',
	'',
	'%% group "Human + AI" Staff, Cup of Tea, Cup, Tea',
	'%% group Energy Power, Electric Kettle',
].join('\n');

const groupLines = (src: string) => src.split('\n').filter(l => /^\s*%%\s*group\s/.test(l));
const read = async (src: string) => {
	const m = await readModel(src, parse);
	return { groups: m.groups ?? [], errors: m.errors.map(e => `${e.line}: ${e.message}`) };
};

describe('reading group lines', () => {
	it('reads a quoted or bare name, then the members', () => {
		expect(groupMarkers(MAP)).toEqual([
			{ line: 21, name: 'Human + AI', members: ['Staff', 'Cup of Tea', 'Cup', 'Tea'] },
			{ line: 22, name: 'Energy', members: ['Power', 'Electric Kettle'] },
		]);
		expect(groupMarkers("wardley-beta\n  %%group 'say \"hi\"' \"Käse\", A.B")[0]).toEqual({ line: 2, name: 'say "hi"', members: ['Käse', 'A.B'] });
	});

	it('merges lines with one name, each member once, in source order', () => {
		expect(groupsOf('wardley-beta\n%% group G A, B\n%% group H C\n%% group G B, D')).toEqual([
			{ name: 'G', members: ['A', 'B', 'D'], line: 2 },
			{ name: 'H', members: ['C'], line: 3 },
		]);
	});

	it('names what is wrong with a line instead of guessing', () => {
		const problems = groupMarkers([
			'wardley-beta', '%% group "Open name A, B', '%% group "" A', '%% group G', `%% group "${'x'.repeat(61)}" A`,
			'%% group G A -> B', '%% group G A, , B',
		].join('\n')).map(m => m.problem);
		expect(problems).toEqual([
			expect.stringMatching(/closing quote/), expect.stringMatching(/no group name/), expect.stringMatching(/no members/),
			expect.stringMatching(/longer than 60/), expect.stringMatching(/a link cannot be a member/), expect.stringMatching(/empty name/),
		]);
	});

	it('leaves other comments alone', () => {
		expect(groupMarkers('wardley-beta\n%% groups of three\n%% grouping A, B\n%% class A highlight')).toEqual([]);
	});
});

describe('edits keep the group lines in step', () => {
	it('rename rewrites members in place, quoting where needed', async () => {
		const s = rename(MAP, 'Cup of Tea', 'Tee-Tasse');
		expect(groupLines(s)[0]).toBe('%% group "Human + AI" Staff, Tee-Tasse, Cup, Tea');
		const q = rename(MAP, 'Staff', 'Käse');
		expect(groupLines(q)[0]).toBe('%% group "Human + AI" "Käse", Cup of Tea, Cup, Tea');
		const m = await read(q);
		expect([m.errors, m.groups[0]]).toEqual([[], { name: 'Human + AI', members: ['Käse', 'Cup of Tea', 'Cup', 'Tea'], line: 21 }]);
	});

	it('deleting an element takes it out of its groups; a group line left empty goes', async () => {
		const s = deleteElement(MAP, 'Staff');
		expect(groupLines(s)).toEqual(['%% group "Human + AI" Cup of Tea, Cup, Tea', '%% group Energy Power, Electric Kettle']);
		const t = deleteElement(deleteElement(MAP, 'Power'), 'Electric Kettle');
		expect(groupLines(t)).toEqual(['%% group "Human + AI" Staff, Cup of Tea, Cup, Tea']);
		expect((await read(t)).errors).toEqual([]);
	});

	it('removing a pipeline takes its components out of their groups', async () => {
		const s = deletePipeline(MAP, 'Kettle');
		expect(groupLines(s)).toEqual(['%% group "Human + AI" Staff, Cup of Tea, Cup, Tea', '%% group Energy Power']);
		expect((await read(s)).errors).toEqual([]);
	});
});

describe('the model', () => {
	it('wardley-read hands the parser no comment lines: fast on many, same lines, accDescr text kept (review 0.20.0)', async () => {
		const src = `wardley-beta\ncomponent A [0.5, 0.5]\n${'%% just a comment\n'.repeat(50000)}component B [0.4, 0.4]`;
		const t = performance.now();
		const m = await readModel(src, parse);
		expect(performance.now() - t).toBeLessThan(800);
		expect(m.elements.find(e => e.name === 'B')?.line).toBe(50003);
		const d = 'wardley-beta\naccDescr {\n  first\n  %% kept as text\n}\ncomponent A [0.5, 0.5]';
		expect((await readModel(d, parse)).accDescr).toBe(((await parse('wardley', d)) as any).accDescr.trim());
	});

	it('wardley-read lists at most 200 errors and counts the rest', async () => {
		const lines = [0, 1, 2].map(k => `%% group G ${Array.from({ length: 100 }, (_, i) => `q${k * 100 + i}`).join(', ')}`);
		const m = await readModel(`${MAP}\n${lines.join('\n')}`, parse);
		expect(m.errors.length).toBe(201);
		expect(m.errors[200]).toEqual({ line: null, message: '… and 100 more errors.' });
	});

	it('wardley-read reports groups with the members that exist, and every line that adds nothing', async () => {
		const m = await read(`${MAP}\n%% group "Human + AI" Teapot\n%% group G\n%% group Ghost Nobody`);
		expect(m.groups).toEqual([
			{ name: 'Human + AI', members: ['Staff', 'Cup of Tea', 'Cup', 'Tea'], line: 21 },
			{ name: 'Energy', members: ['Power', 'Electric Kettle'], line: 22 },
		]);
		expect(m.errors).toEqual([
			'23: group "Human + AI": no element "Teapot" in this map.',
			expect.stringMatching(/^24: group: no members/),
			'25: group "Ghost": no element "Nobody" in this map.',
		]);
	});
});

describe('the boundary', () => {
	const r = GROUP_RADIUS;
	const budget = () => ({ left: 2_000_000 });
	/** Distance from p to the nearest skeleton segment. */
	const toSkeleton = (p: Pt, segs: Segment[]) => Math.min(...segs.map(([s, t]) => {
		const dx = t.x - s.x, dy = t.y - s.y, l2 = dx * dx + dy * dy;
		const u = l2 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2)) : 0;
		return Math.hypot(p.x - s.x - u * dx, p.y - s.y - u * dy);
	}));
	const check = (points: Pt[], links: [number, number][]) => {
		const segs = skeleton(points, links);
		const loops = outline(segs, r, budget())!;
		return { segs, loops, far: Math.max(...loops.flat().map(p => Math.abs(toSkeleton(p, segs) - r))) };
	};

	it('one component: a circle of radius r around it', () => {
		const { loops, far } = check([{ x: 100, y: 100 }], []);
		expect(loops.length).toBe(1);
		expect(far).toBeLessThan(1);
		expect(inside({ x: 100, y: 100 }, loops[0])).toBe(true);
	});

	it('linked components: the disc swept along the links, every component inside', () => {
		const pts = [{ x: 100, y: 100 }, { x: 260, y: 140 }, { x: 330, y: 60 }];
		const { loops, far } = check(pts, [[0, 1], [1, 2]]);
		expect(loops.length).toBe(1);
		expect(far).toBeLessThan(1);
		for (const p of pts) expect(inside(p, loops[0])).toBe(true);
		// Not a hull: the point between the two arms lies outside.
		expect(inside({ x: 240, y: 70 }, loops[0])).toBe(false);
	});

	it('members without links between them are joined into one area by the shortest connections', () => {
		const pts = [{ x: 100, y: 100 }, { x: 300, y: 120 }, { x: 180, y: 300 }];
		const { segs, loops } = check(pts, []);
		expect(segs.length).toBe(2);
		expect(loops.length).toBe(1);
		for (const p of pts) expect(inside(p, loops[0])).toBe(true);
	});

	it('a notch where two arms meet is filled (closing), and nothing of the swept area is lost', () => {
		const pts = [{ x: 100, y: 100 }, { x: 200, y: 90 }, { x: 195, y: 132 }];
		const { segs, loops, far } = check(pts, [[0, 1], [0, 2]]);
		const filled: Pt[] = [];
		for (let x = 100; x <= 230; x += 2) for (let y = 70; y <= 160; y += 2) {
			const p = { x, y };
			if (inside(p, loops[0]) && toSkeleton(p, segs) > r + 2) filled.push(p);
		}
		expect(filled.length).toBeGreaterThan(5);
		// Every outline point is at least r from the skeleton: the closing only adds.
		expect(Math.min(...loops.flat().map(p => toSkeleton(p, segs) - r))).toBeGreaterThan(-0.5);
		expect(far).toBeGreaterThan(2);
	});

	it('a ring of links encloses its middle: holes are filled', () => {
		const pts = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }];
		const { loops } = check(pts, [[0, 1], [1, 2], [2, 3], [3, 0]]);
		expect(loops.length).toBe(1);
		expect(inside({ x: 200, y: 200 }, loops[0])).toBe(true);
	});

	it('the path is closed and made of numbers only', () => {
		const d = pathOf(outline(skeleton([{ x: 10, y: 10 }, { x: 90, y: 40 }], [[0, 1]]), r, budget())!);
		expect(d).toMatch(/^M[-\d.]+,[-\d.]+(C[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+)+Z$/);
	});

	it('a crafted group over a large map stays fast and is still drawn, on a coarser grid (review 0.20.0)', () => {
		// 49 rows across a 2600-unit square, 98 members linked as one zigzag, 20 such groups in one render.
		const pts = Array.from({ length: 98 }, (_, i) => ({ x: (Math.floor(i / 2) % 2 === 0) === (i % 2 === 0) ? 50 : 2650, y: 50 + Math.floor(i / 2) * 54 }));
		const links = pts.slice(1).map((_, i) => [i, i + 1] as [number, number]);
		const t = performance.now();
		const shared = { left: GROUP_BUDGET };
		const drawn = Array.from({ length: 20 }, () => outline(skeleton(pts, links), r, shared)).filter(l => l?.length);
		expect(performance.now() - t).toBeLessThan(600);
		expect(drawn.length).toBeGreaterThanOrEqual(1);
		for (const p of pts) expect(inside(p, drawn[0]![0])).toBe(true);
	});

	it('gives up instead of overspending its budget', () => {
		expect(outline(skeleton([{ x: 0, y: 0 }, { x: 800, y: 500 }], [[0, 1]]), r, { left: 1000 })).toBeNull();
	});
});

describe('drawing groups on the SVG Mermaid returned', () => {
	it('inserts one group of boundaries behind pipelines, links and nodes; nothing else changes', () => {
		const out = applyGroups(SVG, `${SOURCE}\n%% group G Kettle, Power, Grid\n%% group Solo Market`)!;
		const inserted = /<g class="mde-groups">.*?<\/g>/.exec(out)![0];
		expect(out.replace(inserted, '')).toBe(SVG);
		expect(out.indexOf(inserted)).toBe(SVG.indexOf('<g class="wardley-pipelines">'));
		expect(inserted.match(/<path class="mde-group" data-mde-group="(\d)"/g)).toEqual([
			'<path class="mde-group" data-mde-group="0"', '<path class="mde-group" data-mde-group="1"',
		]);
		expect(inserted).toMatch(/^<g class="mde-groups">(<path class="mde-group" data-mde-group="\d" d="[MCZ\d., -]+" fill="none" stroke="#888888" stroke-width="1.5" stroke-dasharray="3 3" pointer-events="none"><\/path>)+<\/g>$/);
	});

	it('draws nothing for a group without a drawn member', () => {
		expect(applyGroups(SVG, `${SOURCE}\n%% group G Teapot`)).toBeNull();
		expect(applyGroups(SVG, SOURCE)).toBeNull();
	});

	it('runs after inertia and classes in the render hook', () => {
		const out = wardleyRender.transform!(SVG, `${SOURCE}\n%% mp-inertia Kettle 0.50\n%% class Kettle highlight\n%% group G Kettle, Public`)!;
		expect(out).toContain('mde-class-highlight');
		expect(out).toMatch(/<line class="wardley-inertia" x1="450"/);
		expect(out).toContain('<g class="mde-groups">');
	});

	it('stays bounded on crafted group lines', () => {
		const many = `${SOURCE}\n${'%% group G Kettle, Power, Grid, Market, Public\n'.repeat(5000)}${Array.from({ length: 200 }, (_, i) => `%% group g${i} Kettle, Market, Grid`).join('\n')}`;
		const t = performance.now();
		const out = applyGroups(SVG, many);
		expect(performance.now() - t).toBeLessThan(1500);
		expect((out!.match(/<path class="mde-group"/g) ?? []).length).toBe(20);
	});
});
