// @vitest-environment happy-dom
/**
 * Groups on Wardley maps (`%% group <name> [label [dx, dy]] <members>`, DEV.md → "Groups for
 * wardley-beta"): the line parser, the edits that keep the lines in step (checked by the real
 * Mermaid parser and read back through the model), classes on groups, the boundary geometry by
 * its properties, and the drawing on an SVG Mermaid produced.
 */
import { describe, expect, it } from 'vitest';
import { timeLimit } from './test-timing';
import { parse } from '@mermaid-js/parser';
import type { Pt } from './wardley-geometry';
import { GROUP_BUDGET, GROUP_RADIUS, inside, outline, pathOf, skeleton, type Segment } from './wardley-groups';
import { readModel } from './wardley-model';
import { applyClasses, applyGroups, wardleyRender } from './wardley-render';
import {
	addElement, addGroupMember, deleteElement, deleteGroup, deletePipeline, formatGroupName, getClasses, groupMarkers, groupsOf, nextGroupName,
	removeGroupMember, rename, renameGroup, setClass, setGroupLabel,
} from './wardley-text';
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

	it('reads the label option after the name: `label` alone, with an offset, or none; `labels` is a member', () => {
		expect(groupMarkers([
			'wardley-beta', '%% group "Tea Shop" label [0, -12.5] Staff, Cup', '%% group G label maker, Kettle', '%% group label A',
			'%% group H labels, B', '%% group I label "label maker"', '%% group J label', '%% group K C',
		].join('\n'))).toEqual([
			{ line: 2, name: 'Tea Shop', members: ['Staff', 'Cup'], label: [0, -12.5] },
			{ line: 3, name: 'G', members: ['maker', 'Kettle'], label: [0, 0] },
			{ line: 4, name: 'label', members: ['A'] },
			{ line: 5, name: 'H', members: ['labels', 'B'] },
			{ line: 6, name: 'I', members: ['label maker'], label: [0, 0] },
			{ line: 7, name: 'J', members: [], label: [0, 0], problem: expect.stringMatching(/no members/) },
			{ line: 8, name: 'K', members: ['C'] },
		]);
		// The first offset among a group's lines counts.
		expect(groupsOf('wardley-beta\n%% group G A\n%% group G label [3, 4] B\n%% group G label [9, 9] C')[0].label).toEqual([3, 4]);
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
			'%% group G A -> B', '%% group G A, , B', '%% group G label [a, 1] A', '%% group G label [1, 2 A',
			// Review 0.21.0: a name is drawn as text and found again by it.
			'%% group " sp " A', '%% group "a\u0001b" A', '%% group "x\uD800" A', '%% group "\uDC00y" A', '%% group "Tea \uD83D\uDE00" A',
		].join('\n')).map(m => m.problem);
		expect(problems).toEqual([
			expect.stringMatching(/closing quote/), expect.stringMatching(/no group name/), expect.stringMatching(/no members/),
			expect.stringMatching(/longer than 60/), expect.stringMatching(/a link cannot be a member/), expect.stringMatching(/empty name/),
			expect.stringMatching(/label offset/), expect.stringMatching(/label offset/),
			expect.stringMatching(/starts or ends with a blank/), expect.stringMatching(/control character/),
			expect.stringMatching(/control character/), expect.stringMatching(/control character/), undefined,
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

	it('a label offset survives member edits; setGroupLabel writes it after the name', async () => {
		const src = MAP.replace('%% group Energy Power', '%% group Energy label [3, 4] Power');
		expect(groupLines(deleteElement(src, 'Electric Kettle'))[1]).toBe('%% group Energy label [3, 4] Power');
		expect(groupLines(rename(src, 'Power', 'Strom'))[1]).toBe('%% group Energy label [3, 4] Strom, Electric Kettle');
		expect(groupLines(setGroupLabel(MAP, 'Human + AI', [5.4, -12.6]))[0]).toBe('%% group "Human + AI" label [5, -13] Staff, Cup of Tea, Cup, Tea');
		expect(groupLines(setGroupLabel(src, 'Energy', [-1, 0]))[1]).toBe('%% group Energy label [-1, 0] Power, Electric Kettle');
		// Several lines: the one carrying the offset is rewritten, the others stay.
		const two = `${MAP}\n%% group Energy label [1, 1] Kettle`;
		expect(groupLines(setGroupLabel(two, 'Energy', [7, 8])).slice(1)).toEqual(['%% group Energy Power, Electric Kettle', '%% group Energy label [7, 8] Kettle']);
		expect(() => setGroupLabel(MAP, 'Ghost', [1, 1])).toThrow(/no group "Ghost"/);
		// Review 0.21.0 (R-1): never an offset the parser would refuse.
		expect(groupLines(setGroupLabel(MAP, 'Energy', [10000, -1e21]))[1]).toBe('%% group Energy label [9999, -9999] Power, Electric Kettle');
		expect(() => setGroupLabel(MAP, 'Energy', [NaN, 0])).toThrow(/number/);
		expect(() => setGroupLabel(MAP, 'Energy', [0, Infinity])).toThrow(/number/);
		expect((await read(setGroupLabel(MAP, 'Energy', [2, -9]))).groups[1]).toEqual({ name: 'Energy', members: ['Power', 'Electric Kettle'], line: 22, label: [2, -9] });
	});

	it('a group that loses its last member takes the class lines naming it along', async () => {
		const src = `${MAP}\n%% class Energy highlight\n%% class Energy, Staff highlight`;
		const s = deleteElement(deleteElement(src, 'Power'), 'Electric Kettle');
		expect(s.split('\n').filter(l => l.startsWith('%% class'))).toEqual(['%% class Staff highlight']);
		expect((await read(s)).errors).toEqual([]);
		const p = deletePipeline(`${MAP.replace('%% group Energy Power, Electric Kettle', '%% group Energy Electric Kettle')}\n%% class Energy highlight`, 'Kettle');
		expect(p).not.toMatch(/%% class/);
	});

	it('a group name cannot be taken by an element; a class is set on a group by its name', async () => {
		expect(() => rename(MAP, 'Staff', 'Energy')).toThrow(/name of a group/);
		expect(() => addElement(MAP, 'component', 'Energy', 0.5, 0.5)).toThrow(/name of a group/);
		const s = setClass(MAP, 'Energy', 'highlight', true);
		expect(s.split('\n').slice(-1)[0]).toBe('%% class Energy highlight');
		expect((await read(s)).groups[1].classes).toEqual(['highlight']);
		expect(setClass(s, 'Energy', 'highlight', false)).toBe(MAP);
	});

	it('removing a pipeline takes its components out of their groups', async () => {
		const s = deletePipeline(MAP, 'Kettle');
		expect(groupLines(s)).toEqual(['%% group "Human + AI" Staff, Cup of Tea, Cup, Tea', '%% group Energy Power']);
		expect((await read(s)).errors).toEqual([]);
	});
});

describe('editing groups graphically (0.22.0)', () => {
	const classLines = (src: string) => src.split('\n').filter(l => l.startsWith('%% class'));

	it('adds a member at the end of the group\'s first line; a member already in it changes nothing', async () => {
		const two = `${MAP}\n%% group Energy Kettle`;
		const s = addGroupMember(two, 'Energy', 'Cup');
		expect(groupLines(s)).toEqual(['%% group "Human + AI" Staff, Cup of Tea, Cup, Tea', '%% group Energy Power, Electric Kettle, Cup', '%% group Energy Kettle']);
		expect(addGroupMember(two, 'Energy', 'Kettle')).toBe(two);
		expect(groupLines(addGroupMember(MAP, 'Human + AI', 'Campfire Kettle'))[0]).toBe('%% group "Human + AI" Staff, Cup of Tea, Cup, Tea, Campfire Kettle');
		expect((await read(s)).errors).toEqual([]);
		expect(() => addGroupMember(MAP, 'Energy', 'Teapot')).toThrow(/Teapot/);
	});

	it('a new group is a line of its own after the last group line, else the last class line, else at the end', async () => {
		const s = addGroupMember(MAP, 'Group 1', 'Kettle');
		expect(s.split('\n').slice(-1)[0]).toBe('%% group "Group 1" Kettle');
		const after = addGroupMember(`${MAP}\nnote "later" [0.10, 0.10]`, 'Group 1', 'Kettle').split('\n');
		expect(after.slice(-3)).toEqual(['%% group Energy Power, Electric Kettle', '%% group "Group 1" Kettle', 'note "later" [0.10, 0.10]']);
		const bare = MAP.split('\n').filter(l => !l.startsWith('%% group')).join('\n');
		const classed = `${bare}\n%% class Kettle highlight\n\nKettle -> Power`.replace('Kettle -> Power\n', '');
		expect(addGroupMember(classed, 'Team', 'Cup').split('\n')).toContain('%% group Team Cup');
		expect(addGroupMember(classed, 'Team', 'Cup').split('\n').indexOf('%% group Team Cup')).toBe(classed.split('\n').indexOf('%% class Kettle highlight') + 1);
		const ended = addGroupMember(`${bare}\n\n`, 'Team', 'Cup');
		expect([ended.trimEnd().split('\n').slice(-1)[0], ended.endsWith('\n\n')]).toEqual(['%% group Team Cup', true]);
		expect((await read(s)).groups.map(g => g.name)).toEqual(['Human + AI', 'Energy', 'Group 1']);
		// A new group's name: free, no element's, no outer blanks.
		expect(() => addGroupMember(MAP, 'Kettle', 'Cup')).toThrow(/name of an element/);
		expect(() => addGroupMember(MAP, ' x', 'Cup')).toThrow(/blank/);
		expect(() => addGroupMember(MAP, '', 'Cup')).toThrow(/needs a name/);
	});

	it('the next free name, and how a group name is written', () => {
		expect(nextGroupName(MAP)).toBe('Group 1');
		expect(nextGroupName(`${MAP}\n%% group "Group 1" Cup`)).toBe('Group 2');
		expect(nextGroupName(MAP.replace('component Cup [', 'component Group 1 ['))).toBe('Group 2');
		expect([formatGroupName('Energy'), formatGroupName('Human + AI'), formatGroupName('say "hi"'), formatGroupName('a,b')]).toEqual(['Energy', '"Human + AI"', `'say "hi"'`, '"a,b"']);
	});

	it('removes a member from that group only; the last one takes the group and its class lines along', async () => {
		const both = `${MAP}\n%% group Mix Cup, Power\n%% class Mix highlight`;
		expect(groupLines(removeGroupMember(both, 'Mix', 'Cup'))).toEqual([
			'%% group "Human + AI" Staff, Cup of Tea, Cup, Tea', '%% group Energy Power, Electric Kettle', '%% group Mix Power',
		]);
		const gone = removeGroupMember(removeGroupMember(both, 'Mix', 'Cup'), 'Mix', 'Power');
		expect(groupLines(gone)).toEqual(['%% group "Human + AI" Staff, Cup of Tea, Cup, Tea', '%% group Energy Power, Electric Kettle']);
		expect(classLines(gone)).toEqual([]);
		expect((await read(gone)).errors).toEqual([]);
		expect(() => removeGroupMember(MAP, 'Ghost', 'Cup')).toThrow(/no group "Ghost"/);
	});

	it('renames a group in all its lines and the class lines naming it', async () => {
		const src = `${MAP}\n%% group Energy label [3, 4] Kettle\n%% class Energy, Staff highlight`;
		const s = renameGroup(src, 'Energy', 'Power Supply');
		expect(groupLines(s).slice(1)).toEqual(['%% group "Power Supply" Power, Electric Kettle', '%% group "Power Supply" label [3, 4] Kettle']);
		expect(classLines(s)).toEqual(['%% class Power Supply, Staff highlight']);
		const m = await read(s);
		expect([m.errors, m.groups[1]]).toEqual([[], { name: 'Power Supply', members: ['Power', 'Electric Kettle', 'Kettle'], line: 22, label: [3, 4], classes: ['highlight'] }]);
		expect(renameGroup(src, 'Energy', 'Energy')).toBe(src);
		expect(() => renameGroup(src, 'Energy', 'Human + AI')).toThrow(/already a group/);
		expect(() => renameGroup(src, 'Energy', 'Kettle')).toThrow(/name of an element/);
		expect(() => renameGroup(src, 'Ghost', 'X')).toThrow(/no group/);
	});

	it('deletes a group with its class lines; its members stay', async () => {
		const src = `${MAP}\n%% group Energy Kettle\n%% class Energy, Staff highlight\n%% class Energy highlight`;
		const s = deleteGroup(src, 'Energy');
		expect(groupLines(s)).toEqual(['%% group "Human + AI" Staff, Cup of Tea, Cup, Tea']);
		expect(classLines(s)).toEqual(['%% class Staff highlight']);
		const m = await read(s);
		expect([m.errors, m.groups.length]).toEqual([[], 1]);
		expect(() => deleteGroup(MAP, 'Ghost')).toThrow(/no group/);
	});

	it('shows a label at the plugin\'s spot, moves it, and takes it off every line', () => {
		const src = `${MAP}\n%% group Energy label [3, 4] Kettle`;
		expect(groupLines(setGroupLabel(MAP, 'Energy', 'auto'))[1]).toBe('%% group Energy label Power, Electric Kettle');
		expect(groupLines(setGroupLabel(src, 'Energy', 'auto')).slice(1)).toEqual(['%% group Energy Power, Electric Kettle', '%% group Energy label Kettle']);
		expect(groupLines(setGroupLabel(src, 'Energy', null)).slice(1)).toEqual(['%% group Energy Power, Electric Kettle', '%% group Energy Kettle']);
		expect(groupsOf(setGroupLabel(MAP, 'Energy', 'auto'))[1].label).toEqual([0, 0]);
		expect(groupsOf(setGroupLabel(src, 'Energy', null))[1].label).toBeUndefined();
		expect(setGroupLabel(MAP, 'Energy', null)).toBe(MAP);
	});

	it('any name the dialog accepts is read back exactly, the map still parses, and no line closes the block', async () => {
		const chars = ['a', 'Z', '0', ' ', '"', "'", ',', '-', '>', '`', '~', '[', ']', '{', '}', '%', '#', ';', ':', 'ä', '☕', '\\', '|', '<', '&'];
		let seed = 7;
		const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
		const base = setClass(addGroupMember(MAP, 'Team', 'Cup'), 'Team', 'highlight', true);
		let checked = 0;
		for (let k = 0; k < 300; k++) {
			const name = Array.from({ length: 1 + rnd(12) }, () => chars[rnd(chars.length)]).join('');
			let s: string;
			try { s = renameGroup(base, 'Team', name); } catch { continue; }
			checked++;
			expect(groupsOf(s).map(g => g.name)).toContain(name);
			expect(getClasses(s, name)).toEqual(['highlight']);
			expect(s.split('\n').some(l => /^ {0,3}(`{3,}|~{3,})/.test(l))).toBe(false);
			expect(groupsOf(addGroupMember(s, name, 'Tea')).find(g => g.name === name)?.members).toEqual(['Cup', 'Tea']);
			if (k % 30 === 0) expect((await read(s)).errors).toEqual([]);
		}
		expect(checked).toBeGreaterThan(150);
	});

	it('class targets of a group: the class goes with the group\'s name, an element of that name keeps its own', () => {
		const s = setClass(addGroupMember(MAP, 'Team', 'Cup'), 'Team', 'highlight', true);
		expect(classLines(renameGroup(s, 'Team', 'Crew'))).toEqual(['%% class Crew highlight']);
		expect(classLines(deleteGroup(s, 'Team'))).toEqual([]);
	});
});

describe('the model', () => {
	it('wardley-read hands the parser no comment lines: fast on many, same lines, accDescr text kept (review 0.20.0)', async () => {
		const src = `wardley-beta\ncomponent A [0.5, 0.5]\n${'%% just a comment\n'.repeat(50000)}component B [0.4, 0.4]`;
		const t = performance.now();
		const m = await readModel(src, parse);
		expect(performance.now() - t).toBeLessThan(timeLimit(800));
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

	it('wardley-read reports a group\'s label and classes, a name shared with an element, and r on an element', async () => {
		const m = await read([
			MAP, '%% group Energy label [4, -6] Power', '%% class Energy highlight', '%% classDef wide r:24, stroke:purple',
			'%% class "Human + AI" wide', '%% class Staff wide', '%% group Kettle Cup', '%% class Nobody highlight',
		].join('\n'));
		expect(m.groups).toEqual([
			{ name: 'Human + AI', members: ['Staff', 'Cup of Tea', 'Cup', 'Tea'], line: 21, classes: ['wide'] },
			{ name: 'Energy', members: ['Power', 'Electric Kettle'], line: 22, label: [4, -6], classes: ['highlight'] },
			{ name: 'Kettle', members: ['Cup'], line: 28 },
		]);
		expect(m.errors).toEqual([
			'27: class wide: r sets a group\'s radius, it does nothing on "Staff".',
			expect.stringMatching(/^28: group "Kettle": an element has the same name/),
			'29: class highlight: no element or group "Nobody" in this map.',
		]);
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
		expect(performance.now() - t).toBeLessThan(timeLimit(600));
		expect(drawn.length).toBeGreaterThanOrEqual(1);
		for (const p of pts) expect(inside(p, drawn[0]![0])).toBe(true);
	});

	it('gives up instead of overspending its budget', () => {
		expect(outline(skeleton([{ x: 0, y: 0 }, { x: 800, y: 500 }], [[0, 1]]), r, { left: 1000 })).toBeNull();
	});
});

describe('drawing groups on the SVG Mermaid returned', () => {
	/** The part applyGroups inserted: the output is the input plus exactly that. */
	const insertedOf = (out: string) => {
		const at = out.indexOf('<g class="mde-groups">');
		return out.slice(at, at + out.length - SVG.length);
	};
	const parsed = (out: string) => new DOMParser().parseFromString(out, 'image/svg+xml');
	/** The extent of group i's boundary, from the numbers of its path. */
	const extent = (out: string, i = 0) => {
		const d = parsed(out).querySelector(`g.mde-group[data-mde-group="${i}"] > path`)!.getAttribute('d')!;
		const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
		const xs = n.filter((_, k) => k % 2 === 0), ys = n.filter((_, k) => k % 2 === 1);
		return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), width: Math.max(...xs) - Math.min(...xs) };
	};
	const labelOf = (out: string, i = 0) => {
		const t = parsed(out).querySelector(`g.mde-group[data-mde-group="${i}"] > text`)!;
		return { x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')), text: t.textContent, style: t.getAttribute('style') };
	};

	it('inserts one group of boundaries and labels behind pipelines, links and nodes; nothing else changes', () => {
		const out = applyGroups(SVG, `${SOURCE}\n%% group G label Kettle, Power, Grid\n%% group Solo Market`)!;
		const inserted = insertedOf(out);
		expect(out.replace(inserted, '')).toBe(SVG);
		expect(out.indexOf(inserted)).toBe(SVG.indexOf('<g class="wardley-pipelines">'));
		// Without a class a group is drawn in the map's own line colour (#333333 in this drawing), dashed;
		// its name only with `label`.
		const path = `<path class="mde-group-boundary" d="[MCZ\\d., -]+" fill="none" fill-opacity="0.12" stroke="#333333" stroke-width="1.5" stroke-dasharray="4 3" stroke-linecap="round" pointer-events="none"></path>`;
		const label = `<text class="mde-group-label" data-mde-group="0" x="[-\\d.]+" y="[-\\d.]+" fill="#333333" font-size="10" font-style="italic" text-anchor="middle">G</text>`;
		expect(inserted).toMatch(new RegExp(`^<g class="mde-groups"><g class="mde-group" data-mde-group="0">${path}${label}</g><g class="mde-group" data-mde-group="1">${path}</g></g>$`));
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

	it('classes style a group like a node: highlight by class name, a classDef inline on boundary and label', () => {
		const lit = applyGroups(SVG, `${SOURCE}\n%% group "Big G" Kettle, Power\n%% class "Big G" highlight`)!;
		expect(lit).toContain('<g class="mde-group mde-class mde-class-highlight" data-mde-group="0"><path class="mde-group-boundary" d="');
		expect(insertedOf(lit)).not.toContain(' style="');
		const styled = applyGroups(SVG, `${SOURCE}\n%% group G label Kettle\n%% classDef team stroke:purple, stroke-dasharray:2 2, fill:#00ff00, color:#123456, font-weight:bold\n%% class G team`)!;
		expect(styled).toMatch(/<path style="stroke:var\(--color-purple\);stroke-dasharray:2 2;fill:#00ff00" class="mde-group-boundary" d="/);
		expect(labelOf(styled).style).toBe('fill:#123456;font-weight:bold');
		// Without color the label takes the boundary's stroke.
		expect(labelOf(applyGroups(SVG, `${SOURCE}\n%% group G label Kettle\n%% classDef team stroke:green\n%% class G team`)!).style).toBe('fill:var(--color-green)');
	});

	it('the eight theme colour names become the theme\'s colours, on nodes too; other names stay', () => {
		const out = applyClasses(SVG, `${SOURCE}\n%% classDef hot stroke:Red, fill:salmon\n%% class Kettle hot`)!;
		expect(out).toContain('style="stroke:var(--color-red);fill:salmon"');
	});

	it('a class and a group of one name: the class goes to the element', () => {
		const out = applyGroups(SVG, `${SOURCE}\n%% group Kettle Power, Grid\n%% class Kettle highlight`)!;
		expect(out).toContain('<g class="mde-group" data-mde-group="0">');
	});

	it('a classDef r sets the radius; groups sharing members run outside the smaller one, unless r is set', () => {
		const alone = extent(applyGroups(SVG, `${SOURCE}\n%% group B Kettle, Power`)!);
		const one = extent(applyGroups(SVG, `${SOURCE}\n%% group A Kettle`)!);
		expect(one.width).toBeCloseTo(2 * GROUP_RADIUS, 0);
		const wide = extent(applyGroups(SVG, `${SOURCE}\n%% group A Kettle\n%% classDef wide r:24\n%% class A wide`)!);
		expect(wide.width).toBeCloseTo(48, 0);
		// B shares Kettle with the smaller A: one step (6) further out, whichever comes first.
		for (const src of [`%% group A Kettle\n%% group B Kettle, Power`, `%% group B Kettle, Power\n%% group A Kettle`]) {
			const out = applyGroups(SVG, `${SOURCE}\n${src}`)!;
			const b = extent(out, src.startsWith('%% group A') ? 1 : 0), a = extent(out, src.startsWith('%% group A') ? 0 : 1);
			expect(b.width - alone.width).toBeCloseTo(12, 0);
			expect(a.width).toBeCloseTo(one.width, 0);
		}
		// Disjoint groups are not staggered; an explicit r is kept.
		expect(extent(applyGroups(SVG, `${SOURCE}\n%% group A Market\n%% group B Kettle, Power`)!, 1).width).toBeCloseTo(alone.width, 0);
		const fixed = applyGroups(SVG, `${SOURCE}\n%% group A Kettle\n%% group B Kettle, Power\n%% classDef std r:16\n%% class B std`)!;
		expect(extent(fixed, 1).width).toBeCloseTo(alone.width, 0);
	});

	it('the label sits centred above the boundary, moves by its offset, goes below without room, stays inside', () => {
		const src = `${SOURCE}\n%% group A label Kettle`;
		const out = applyGroups(SVG, src)!;
		const box = extent(out), at = labelOf(out);
		expect(at.y).toBeCloseTo(box.top - 4, 0);
		expect(at.x).toBeCloseTo(369.6, 0);
		const moved = labelOf(applyGroups(SVG, src.replace('group A label Kettle', 'group A label [10, -5] Kettle'))!);
		expect([moved.x - at.x, moved.y - at.y]).toEqual([10, -5]);
		// The map's top at 300: no room above Kettle's group, so the label goes below it.
		const low = applyGroups(SVG.replace('viewBox="0 0 900 600"', 'viewBox="0 380 900 220"'), src)!;
		expect(labelOf(low).y).toBeCloseTo(extent(low).bottom + 14, 0);
		// A map 360 wide: the label of a group at x 369.6 is pulled inside.
		expect(labelOf(applyGroups(SVG.replace('viewBox="0 0 900 600"', 'viewBox="0 0 360 600"'), src)!).x).toBeCloseTo(360 - 4.75, 0);
	});

	it('labels of groups sharing their top member do not overlap: the outer one moves up, a placed one stays', () => {
		const out = applyGroups(SVG, `${SOURCE}\n%% group Inner label Kettle\n%% group Outer label Kettle, Power`)!;
		const inner = labelOf(out, 0), outer = labelOf(out, 1);
		expect(inner.y).toBeCloseTo(extent(out, 0).top - 4, 0);
		expect(inner.y - outer.y).toBeGreaterThanOrEqual(12);
		// Outer's label moved by hand stays where it was put; Inner's gives way.
		const fixed = applyGroups(SVG, `${SOURCE}\n%% group Inner label Kettle\n%% group Outer label [0, -1] Kettle, Power`)!;
		expect(labelOf(fixed, 1).y).toBeCloseTo(extent(fixed, 1).top - 5, 0);
		expect(labelOf(fixed, 1).y - labelOf(fixed, 0).y).toBeGreaterThanOrEqual(12);
		// Groups far apart keep their own spots.
		const apart = applyGroups(SVG, `${SOURCE}\n%% group A label Kettle\n%% group B label Market`)!;
		expect(labelOf(apart, 1).y).toBeCloseTo(extent(apart, 1).top - 4, 0);
	});

	it('the name is written as text: markup in a name stays text', () => {
		const out = applyGroups(SVG, `${SOURCE}\n%% group "<b>x</b> & <script>y" label Kettle`)!;
		expect(insertedOf(out)).toContain('>&lt;b&gt;x&lt;/b&gt; &amp; &lt;script&gt;y</text>');
		const doc = parsed(out);
		expect(doc.querySelector('parsererror')).toBeNull();
		expect(doc.querySelectorAll('g.mde-groups *').length).toBe(3);
		expect(labelOf(out).text).toBe('<b>x</b> & <script>y');
		// Quotes too, so the name could go into an attribute later (review 0.21.0, R-2).
		const quoted = applyGroups(SVG, `${SOURCE}\n%% group 'say "hi"' label Kettle\n%% group "it's" label Power`)!;
		expect(insertedOf(quoted)).toContain('>say &quot;hi&quot;</text>');
		expect(insertedOf(quoted)).toContain('>it&#39;s</text>');
		expect([labelOf(quoted, 0).text, labelOf(quoted, 1).text]).toEqual(['say "hi"', "it's"]);
	});

	it('a name looking like an attribute does not stop the label from taking its style (review 0.21.0, R-4)', () => {
		const out = applyGroups(SVG, `${SOURCE}\n%% group 'a style="b' label Kettle\n%% classDef c color:red\n%% class 'a style="b' c`)!;
		expect(labelOf(out).style).toBe('fill:var(--color-red)');
	});

	it('stays bounded on crafted group lines', () => {
		const many = `${SOURCE}\n${'%% group G Kettle, Power, Grid, Market, Public\n'.repeat(5000)}${Array.from({ length: 200 }, (_, i) => `%% group g${i} Kettle, Market, Grid`).join('\n')}`;
		const t = performance.now();
		const out = applyGroups(SVG, many);
		expect(performance.now() - t).toBeLessThan(timeLimit(1500));
		expect((out!.match(/<path class="mde-group-boundary"/g) ?? []).length).toBe(20);
	});
});
