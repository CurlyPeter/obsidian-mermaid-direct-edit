import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import { CliError } from './cli';
import { applyModel, readModel } from './wardley-model';
import { isWardley, mermaidBlocks, setMethod, setTitle } from './wardley-text';

const TEA = `wardley-beta
title Tea Shop

anchor Business [0.95, 0.63]
anchor Public [0.95, 0.78]
component Cup of Tea [0.81, 0.57] label [-50, 18]
component Hot Water [0.52, 0.80]
component Water [0.38, 0.84]
component Kettle [0.38, 0.48] label [-48, -4]
pipeline Kettle {
  component Campfire Kettle [0.37] label [-40, 22]
  component Electric Kettle [0.68] label [-35, 22]
}
component Power [0.10, 0.70] label [-38, 4] (inertia)
component Tea [0.70, 0.81]
%% mp-inertia Power 0.80

Business -> Cup of Tea
Public +> Cup of Tea; buys
Cup of Tea -> Hot Water
Hot Water -> Water
Hot Water -> Kettle; limited by
Kettle -.-> Power
Tea -> Cup of Tea

evolve Power 0.92
evolve Hot Water 1.00

note "Standardising power allows kettles to evolve faster" [0.15, 0.12]
accelerator Open source [0.39, 0.91]
deaccelerator Habit [0.38, 0.20]`;

const read = (src: string) => readModel(src, parse);
const apply = (src: string, model: unknown, opts = {}) => applyModel(src, model, parse, opts);
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof CliError ? `${e.code}: ${e.message}` : String(e); } };
const el = <T extends { name: string }>(m: { elements: T[] }, name: string) => m.elements.find(e => e.name === name);

describe('wardley-read (acceptance 1): the Tea Shop map', () => {
	it('reads pipeline components at the parent visibility, with labels', async () => {
		const m = await read(TEA);
		expect(m.schema).toBe(1);
		expect(m.title).toBe('Tea Shop');
		expect(m.scale).toBe('decimal');
		expect(el(m, 'Campfire Kettle')).toEqual({ name: 'Campfire Kettle', kind: 'component', visibility: 0.38, evolution: 0.37, line: 11, pipeline: 'Kettle', label: [-40, 22] });
		expect(el(m, 'Electric Kettle')).toEqual({ name: 'Electric Kettle', kind: 'component', visibility: 0.38, evolution: 0.68, line: 12, pipeline: 'Kettle', label: [-35, 22] });
		expect(m.pipelines).toEqual([{ parent: 'Kettle', children: ['Campfire Kettle', 'Electric Kettle'], line: 10 }]);
		expect(el(m, 'Business')).toEqual({ name: 'Business', kind: 'anchor', visibility: 0.95, evolution: 0.63, line: 4 });
		expect(m.elements).toHaveLength(10);
	});
	it('reads link labels and kinds, forces, inertia and its marker', async () => {
		const m = await read(TEA);
		expect(m.links.find(l => l.from === 'Public')).toEqual({ from: 'Public', to: 'Cup of Tea', kind: '+>', label: 'buys', flow: true, line: 19 });
		expect(m.links.find(l => l.to === 'Kettle')).toEqual({ from: 'Hot Water', to: 'Kettle', kind: '->', label: 'limited by', line: 22 });
		expect(m.links.find(l => l.to === 'Power')?.kind).toBe('-.->');
		expect(m.forces).toEqual([
			{ kind: 'accelerator', name: 'Open source', visibility: 0.39, evolution: 0.91, line: 30 },
			{ kind: 'deaccelerator', name: 'Habit', visibility: 0.38, evolution: 0.2, line: 31 },
		]);
		expect(el(m, 'Power')).toMatchObject({ inertia: true, inertiaAt: 0.8, label: [-38, 4] });
		expect(m.evolves).toEqual([{ name: 'Power', evolution: 0.92, line: 26 }, { name: 'Hot Water', evolution: 1, line: 27 }]);
		expect(m.notes).toEqual([{ text: 'Standardising power allows kettles to evolve faster', visibility: 0.15, evolution: 0.12, line: 29 }]);
		expect(m.errors).toEqual([]);
		expect(m.unsupported).toEqual([]);
	});
	it('reads every other statement: method, flow labels, size, stages, annotations', async () => {
		const m = await read(`wardley-beta
size [800, 600]
evolution Genesis -> Custom@0.3 -> Product / Rental -> Commodity
anchor A [0.9, 0.5]
component B [0.5, 0.5] (build)
component C [0.4, 0.4] label [5, 5] (market) (inertia)
A +'pays'> B
B +<> C
annotation 1,[0.1, 0.2] "first"
annotations [0.05, 0.9]`);
		expect(m.size).toEqual({ width: 800, height: 600 });
		expect(m.stages).toEqual([{ label: 'Genesis' }, { label: 'Custom', boundary: 0.3 }, { label: 'Product / Rental' }, { label: 'Commodity' }]);
		expect(el(m, 'B')?.method).toBe('build');
		expect(el(m, 'C')).toMatchObject({ method: 'market', inertia: true, label: [5, 5] });
		expect(m.links[0]).toEqual({ from: 'A', to: 'B', kind: "+'pays'>", label: 'pays', flow: true, line: 7 });
		expect(m.links[1].kind).toBe('+<>');
		expect(m.annotations).toEqual([{ number: 1, text: 'first', visibility: 0.1, evolution: 0.2, line: 9 }]);
		expect(m.annotationsBox).toEqual({ visibility: 0.05, evolution: 0.9, line: 10 });
		expect(m.unsupported).toEqual([]);
	});
});

describe('wardley-read: errors with line numbers', () => {
	it('(acceptance 2) a one-value component at top level is a parse error, never vis -40', async () => {
		expect(await code(read('wardley-beta\ntitle X\ncomponent A [0.37] label [-40, 22]'))).toMatch(/^parse-error: line 3, column \d+: /);
	});
	it('(acceptance 3) a value outside 0..1 is reported with its line', async () => {
		expect(await code(read('wardley-beta\ncomponent A [1.4, -0.2]'))).toMatch(/^parse-error: line 2, column \d+: /);
		const m = await read('wardley-beta\nanchor U [0.9, 0.5]\ncomponent A [1.4, 0.2]\ncomponent B [0.5, 0.5]');
		expect(m.errors).toEqual([{ line: 3, message: '"A" visibility: 1.4 is outside 0-1; Mermaid reads it as 1.4 %.' }]);
		expect(el(m, 'A')).toMatchObject({ visibility: 0.014, evolution: 0.2 });
		expect((await read('wardley-beta\ncomponent A [0.5, 150.0]')).errors[0]).toMatchObject({ line: 2, message: expect.stringContaining('refuses') });
	});
	it('converts a 0-100 map and flags a decimal value in it', async () => {
		const m = await read('wardley-beta\nanchor U [95.0, 50.0]\ncomponent A [40.0, 60.0]\ncomponent B [0.5, 30.0]');
		expect(m.scale).toBe('percent');
		expect(el(m, 'A')).toMatchObject({ visibility: 0.4, evolution: 0.6 });
		expect(m.errors).toEqual([{ line: 4, message: '"B" visibility: 0.5 in a 0-100 map; Mermaid reads it as 50 %.' }]);
	});
	it('reports undeclared names, duplicates and a stray inertia marker', async () => {
		const m = await read('wardley-beta\nanchor A [0.9, 0.5]\nanchor A [0.8, 0.5]\nA -> Zed\nevolve Zed 0.5\n%% mp-inertia A 0.3');
		expect(m.errors.map(e => e.line)).toEqual([3, 4, 5, 6]);
		expect(m.errors[0].message).toContain('declared twice');
	});
});

describe('wardley-apply', () => {
	it('(acceptance 4) the model read from the same text changes nothing', async () => {
		const r = await apply(TEA, await read(TEA));
		expect(r.changes).toEqual([]);
		expect(r.conflicts).toEqual([]);
		expect(r.source).toBe(TEA);
	});
	it('(acceptance 4) moving Tea and Campfire Kettle changes exactly those two lines', async () => {
		const m = await read(TEA);
		el(m, 'Tea')!.visibility = 0.66; el(m, 'Tea')!.evolution = 0.85;
		el(m, 'Campfire Kettle')!.evolution = 0.3;
		const r = await apply(TEA, m);
		expect(r.conflicts).toEqual([]);
		expect(r.changes).toEqual([
			{ op: 'move', what: 'component Tea', from: [0.7, 0.81], to: [0.66, 0.85], line: 15 },
			{ op: 'move', what: 'component Campfire Kettle', from: [0.38, 0.37], to: [0.38, 0.3], line: 11 },
		]);
		const before = TEA.split('\n'), after = r.source.split('\n');
		expect(after).toHaveLength(before.length);
		const diff = before.map((l, i) => (l === after[i] ? null : i + 1)).filter(Boolean);
		expect(diff).toEqual([11, 15]);
		expect(after[10]).toBe('  component Campfire Kettle [0.30] label [-40, 22]');
		expect(after[14]).toBe('component Tea [0.66, 0.85]');
	});
	it('within the tolerance nothing moves', async () => {
		const m = await read(TEA);
		el(m, 'Tea')!.visibility = 0.705;
		expect((await apply(TEA, m)).changes).toEqual([]);
		expect((await apply(TEA, m, { tolerance: 0.001 })).changes).toHaveLength(1);
	});
	it('adds what the model has and the text not, after the existing lines of each kind', async () => {
		const m = await read(TEA);
		m.elements.push({ name: 'Milk', kind: 'component', visibility: 0.5, evolution: 0.6, line: 0, method: 'buy' });
		m.links.push({ from: 'Cup of Tea', to: 'Milk', kind: '-.->', label: 'needs', line: 0 });
		m.evolves.push({ name: 'Milk', evolution: 0.8, line: 0 });
		m.notes.push({ text: 'New note', visibility: 0.2, evolution: 0.3, line: 0 });
		m.forces.push({ kind: 'accelerator', name: 'Cheap power', visibility: 0.1, evolution: 0.5, line: 0 });
		const r = await apply(TEA, m);
		expect(r.conflicts).toEqual([]);
		expect(r.changes.map(c => [c.op, c.what])).toEqual([
			['add', 'component Milk'], ['add', 'link Cup of Tea -.-> Milk; needs'], ['add', 'evolve Milk'],
			['add', 'note "New note"'], ['add', 'accelerator Cheap power'],
		]);
		expect(r.source).toContain('component Milk [0.50, 0.60] (buy)\n');
		expect(r.source).toContain('Tea -> Cup of Tea\nCup of Tea -.-> Milk; needs\n');
		const back = await read(r.source);
		expect(el(back, 'Milk')).toMatchObject({ visibility: 0.5, evolution: 0.6, method: 'buy' });
		expect(r.changes.every(c => typeof c.line === 'number')).toBe(true);
		expect((await apply(r.source, back)).changes).toEqual([]);
	});
	it('reports removals, applies them only with allow-delete', async () => {
		const m = await read(TEA);
		m.elements = m.elements.filter(e => e.name !== 'Water');
		m.links = m.links.filter(l => l.to !== 'Water');
		m.notes = [];
		const r = await apply(TEA, m);
		expect(r.changes).toEqual([]);
		expect(r.source).toBe(TEA);
		expect(r.conflicts.map(c => [c.what, c.line])).toEqual([['link Hot Water -> Water', 21], ['note "Standardising power allows kettles to evolve faster"', 29], ['component Water', 8]]);
		const d = await apply(TEA, m, { allowDelete: true });
		expect(d.conflicts).toEqual([]);
		expect(d.changes.map(c => c.op)).toEqual(['remove', 'remove', 'remove']);
		expect(d.source).not.toMatch(/^component Water |-> Water$|^note /m);
	});
	it('an entry without a field keeps the text: no pipeline, label, inertia, method, kind or visibility key', async () => {
		const m = await read(TEA);
		const bare = { elements: m.elements.map(({ name, visibility, evolution, pipeline }) => (pipeline ? { name, evolution } : { name, visibility, evolution })) };
		const r = await apply(TEA, bare, { tolerance: 0.011 });
		expect(r.conflicts).toEqual([]);
		expect(r.changes).toEqual([]);
		const board = { elements: m.elements.map(({ name, visibility, evolution }) => ({ name, visibility, evolution })) };
		expect(await apply(TEA, board)).toMatchObject({ changes: [], conflicts: [] });
		const explicit = { elements: m.elements.map(e => (e.name === 'Campfire Kettle' ? { ...e, pipeline: null } : e)) };
		expect((await apply(TEA, explicit)).conflicts.map(c => c.what)).toEqual(['component Campfire Kettle']);
		expect((await apply(TEA, { elements: [...m.elements, { name: 'New', evolution: 0.5 }] })).conflicts[0].message).toContain('needs a visibility');
	});
	it('leaves sections the model does not carry alone', async () => {
		const m = await read(TEA);
		const r = await apply(TEA, { elements: m.elements });
		expect(r.changes).toEqual([]);
		expect(r.conflicts).toEqual([]);
	});
	it('changes link kinds and labels only when the model carries them', async () => {
		const m = await read(TEA);
		const r = await apply(TEA, { links: m.links.map(l => (l.to === 'Kettle' ? { from: l.from, to: l.to, label: 'needs' } : { from: l.from, to: l.to })) });
		expect(r.changes).toEqual([{ op: 'update', what: 'link Hot Water -> Kettle', from: { kind: '->', label: 'limited by' }, to: { kind: '->', label: 'needs' }, line: 22 }]);
		expect(r.source).toBe(TEA.replace('Kettle; limited by', 'Kettle; needs'));
	});
	it('reports a pipeline child moved off its parent visibility, a kind or direction change as conflicts', async () => {
		const m = await read(TEA);
		el(m, 'Electric Kettle')!.visibility = 0.5;
		el(m, 'Business')!.kind = 'component';
		const l = m.links.find(x => x.from === 'Tea')!;
		[l.from, l.to] = [l.to, l.from];
		const r = await apply(TEA, m);
		expect(r.changes).toEqual([]);
		expect(r.conflicts.map(c => c.what)).toEqual(['component Business', 'component Electric Kettle', 'link Cup of Tea -> Tea']);
		expect(r.source).toBe(TEA);
	});
	it('turns a model into a new map from source="wardley-beta"', async () => {
		const m = await read(TEA);
		const r = await apply('wardley-beta', m);
		expect(r.conflicts).toEqual([]);
		const back = await read(r.source);
		const strip = (x: typeof m) => ({ ...x, elements: x.elements.map(({ line, ...e }) => e).sort((a, b) => a.name.localeCompare(b.name)),
			links: x.links.map(({ line, ...l }) => l), evolves: x.evolves.map(({ line, ...e }) => e), notes: x.notes.map(({ line, ...n }) => n),
			forces: x.forces.map(({ line, ...f }) => f), pipelines: x.pipelines.map(({ line, ...p }) => p) });
		const want = strip(m), got = strip(back);
		// inertiaAt is the plugin's comment extension, not part of what apply writes
		delete want.elements.find(e => e.name === 'Power')!.inertiaAt;
		expect(got.elements).toEqual(want.elements);
		expect(got.links).toEqual(want.links);
		expect(got.evolves).toEqual(want.evolves);
		expect(got.notes).toEqual(want.notes);
		expect(got.forces).toEqual(want.forces);
		expect(got.pipelines).toEqual(want.pipelines);
		expect(back.title).toBe('Tea Shop');
		expect(back.errors).toEqual([]);
	});
	it('refuses what it cannot edit, and a malformed model', async () => {
		expect(await code(apply('wardley-beta\ncomponent A [40.0, 60.0]', { elements: [] }))).toMatch(/^not-editable: .*0-100/);
		expect(await code(apply('wardley-beta\ncomponent A [0.4', { elements: [] }))).toMatch(/^parse-error: line 2/);
		expect(await code(apply(TEA, { elements: [{ name: 'X' }] }))).toMatch(/^bad-model: elements\[0\]\.evolution/);
		expect(await code(apply(TEA, { links: [{ from: 'A', to: 'B', kind: '=>' }] }))).toMatch(/^bad-model: .*not an arrow/);
		expect(await code(apply(TEA, [1]))).toMatch(/^bad-model/);
	});
});

describe('text helpers used by the model', () => {
	it('finds the wardley blocks of a note', () => {
		const note = '# N\n```mermaid\nflowchart LR\nA-->B\n```\n\n```mermaid\n%% c\nwardley-beta\ntitle X\n```\n> ```mermaid\n> wardley-beta\n> ```\n';
		const blocks = mermaidBlocks(note).filter(b => isWardley(b.body));
		expect(blocks.map(b => b.body)).toEqual(['%% c\nwardley-beta\ntitle X']);
		expect(note.slice(blocks[0].from, blocks[0].from + 4)).toBe('%% c');
	});
	it('sets the title and the sourcing method in place', async () => {
		expect(setTitle('wardley-beta\nanchor A [0.1, 0.1]', 'T')).toBe('wardley-beta\ntitle T\nanchor A [0.1, 0.1]');
		expect(setTitle('wardley-beta\ntitle Old\n', '')).toBe('wardley-beta\n');
		const src = 'wardley-beta\ncomponent A [0.4, 0.4] label [5, 5] (build) (inertia)';
		expect(setMethod(src, 'A', 'market')).toBe('wardley-beta\ncomponent A [0.4, 0.4] label [5, 5] (market) (inertia)');
		expect(setMethod(src, 'A', null)).toBe('wardley-beta\ncomponent A [0.4, 0.4] label [5, 5] (inertia)');
		expect(setMethod('wardley-beta\ncomponent A [0.4, 0.4] (inertia)', 'A', 'buy')).toBe('wardley-beta\ncomponent A [0.4, 0.4] (buy) (inertia)');
		for (const out of [setMethod(src, 'A', 'market'), setMethod(src, 'A', null)]) await parse('wardley', out);
	});
});
