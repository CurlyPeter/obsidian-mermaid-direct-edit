/**
 * Moving existing components into and out of pipelines (DEV.md → "Editing pipelines (0.27.0)"):
 * the text edits, checked by the real Mermaid parser and read back through the model, and the
 * rules a pipeline component imposes (no evolve, no type, no inertia, one pipeline at most).
 */
import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import { timeLimit } from './test-timing';
import { readModel } from './wardley-model';
import {
	clearPipelineBlockers, describeBlockers, getClasses, groupsOf, moveIntoPipeline, pipelineBlockers, pipelineOf, pipelineParentOf,
	takeOutOfPipeline,
} from './wardley-text';

const MAP = [
	'wardley-beta',
	'anchor Public [0.95, 0.62]',
	'component Cup of Tea [0.79, 0.61]',
	'component Kettle [0.43, 0.35]',
	'component Power [0.10, 0.70]',
	'component "Gas Stove" [0.30, 0.20] label [-30, 12]',
	'component Induction [0.25, 0.75] (buy) (inertia)',
	'%% mp-inertia Induction 0.82',
	'component Teapot [0.60, 0.50]',
	'',
	'Public -> Cup of Tea',
	'Cup of Tea -> Kettle',
	'Kettle -> Power',
	'"Gas Stove" -> Power',
	'Cup of Tea -> "Gas Stove"',
	'',
	'evolve Teapot 0.70',
	'pipeline Kettle {',
	'  component Campfire Kettle [0.15]',
	'  component Electric Kettle [0.62] label [5, 20]',
	'}',
	'',
	'%% class "Gas Stove" highlight',
	'%% group Energy Power, "Gas Stove"',
].join('\n');

/** The model of `src`: parses with Mermaid's own parser (throws otherwise) and reports no errors. */
const model = async (src: string) => {
	const m = await readModel(src, parse);
	expect(m.errors).toEqual([]);
	return m;
};
const el = async (src: string, name: string) => (await model(src)).elements.find(e => e.name === name)!;

describe('moveIntoPipeline', () => {
	it('moves a top-level component into an existing pipeline, onto the parent line, evolution and label kept', async () => {
		const out = moveIntoPipeline(MAP, 'Kettle', 'Gas Stove');
		expect(out).not.toContain('component "Gas Stove" [0.30, 0.20]');
		expect(out).toContain('  component Electric Kettle [0.62] label [5, 20]\n  component "Gas Stove" [0.20] label [-30, 12]\n}');
		expect(pipelineOf(out, 'Kettle')).toEqual(['Campfire Kettle', 'Electric Kettle', 'Gas Stove']);
		const g = await el(out, 'Gas Stove');
		expect(g).toMatchObject({ pipeline: 'Kettle', visibility: 0.43, evolution: 0.2, label: [-30, 12] });
		// Links, classes and groups name it and stay.
		expect(out).toContain('"Gas Stove" -> Power');
		expect(getClasses(out, 'Gas Stove')).toEqual(['highlight']);
		expect(groupsOf(out).find(x => x.name === 'Energy')?.members).toEqual(['Power', 'Gas Stove']);
		expect(out.split('\n').length).toBe(MAP.split('\n').length);
	});

	it('creates the block after the parent when it has none', async () => {
		const out = moveIntoPipeline(MAP, 'Cup of Tea', 'Power');
		expect(out).toContain('component Cup of Tea [0.79, 0.61]\npipeline Cup of Tea {\n  component Power [0.70]\n}\ncomponent Kettle');
		expect((await el(out, 'Power')).visibility).toBe(0.79);
	});

	it('changes a component over from another pipeline; a block left empty goes', async () => {
		const two = moveIntoPipeline(MAP, 'Cup of Tea', 'Power');
		const out = moveIntoPipeline(two, 'Kettle', 'Power');
		expect(pipelineOf(out, 'Cup of Tea')).toBeNull();
		expect(out).not.toContain('pipeline Cup of Tea');
		expect(pipelineOf(out, 'Kettle')).toEqual(['Campfire Kettle', 'Electric Kettle', 'Power']);
		const back = moveIntoPipeline(out, 'Cup of Tea', 'Campfire Kettle');
		expect(pipelineOf(back, 'Kettle')).toEqual(['Electric Kettle', 'Power']);
		expect(pipelineParentOf(back, 'Campfire Kettle')).toBe('Cup of Tea');
		await model(back);
	});

	it('writes its links top to bottom again, now that it sits on the parent line', () => {
		// Power (0.10) moves up to Cup of Tea (0.79), above Kettle (0.43): `Kettle -> Power` turns.
		const out = moveIntoPipeline(MAP, 'Cup of Tea', 'Power');
		expect(out).toContain('Power -> Kettle');
		// A link to the parent is level now and stays as written.
		expect(moveIntoPipeline(MAP, 'Kettle', 'Power')).toContain('Kettle -> Power');
	});

	it('keeps a link to the parent drawn: `Child -> Parent` is written `Parent -> Child`, a flow keeps its direction', async () => {
		const up = 'wardley-beta\ncomponent P [0.40, 0.40]\ncomponent C [0.60, 0.50]\ncomponent F [0.70, 0.30]\nC -> P\nF +> P';
		const out = moveIntoPipeline(moveIntoPipeline(up, 'P', 'C'), 'P', 'F');
		expect(out).toContain('\nP -> C');
		expect(out).not.toContain('C -> P');
		expect(out).toContain('F +> P');
		expect(takeOutOfPipeline(out, 'C')).toContain('\nP -> C');
		await model(out);
	});

	it('works with quoted names in an indented map', async () => {
		const src = 'wardley-beta\n  component "Käse Laib" [0.40, 0.30]\n  component "Brie.1" [0.20, 0.50] label [4, 4]\n  "Käse Laib" -> "Brie.1"';
		const out = moveIntoPipeline(src, 'Käse Laib', 'Brie.1');
		expect(out).toBe('wardley-beta\n  component "Käse Laib" [0.40, 0.30]\n  pipeline "Käse Laib" {\n    component "Brie.1" [0.50] label [4, 4]\n  }\n  "Käse Laib" -> "Brie.1"');
		await model(out);
		expect(takeOutOfPipeline(out, 'Brie.1')).toBe('wardley-beta\n  component "Käse Laib" [0.40, 0.30]\n  component "Brie.1" [0.40, 0.50] label [4, 4]\n  "Käse Laib" -> "Brie.1"');
	});

	it('refuses what a pipeline cannot hold', () => {
		expect(() => moveIntoPipeline(MAP, 'Public', 'Power')).toThrow(/Anchors cannot have a pipeline/);
		expect(() => moveIntoPipeline(MAP, 'Kettle', 'Public')).toThrow(/anchor cannot be in a pipeline/);
		expect(() => moveIntoPipeline(MAP, 'Kettle', 'Kettle')).toThrow(/its own pipeline/);
		expect(() => moveIntoPipeline(MAP, 'Cup of Tea', 'Kettle')).toThrow(/pipeline of its own/);
		expect(() => moveIntoPipeline(MAP, 'Electric Kettle', 'Power')).toThrow(/in a pipeline itself/);
		expect(() => moveIntoPipeline(MAP, 'Kettle', 'Electric Kettle')).toThrow(/already in the pipeline/);
		expect(() => moveIntoPipeline(MAP, 'Kettle', 'Nobody')).toThrow(/not declared/);
		expect(() => moveIntoPipeline(`${MAP}\ncomponent Odd [0.5, 0.5] something`, 'Kettle', 'Odd')).toThrow(/edit it in the source/);
		expect(() => moveIntoPipeline(`${MAP}\ncomponent Odd [0.5, 0.5] label [1, 2] something`, 'Kettle', 'Odd')).toThrow(/edit it in the source/);
	});

	it('refuses an evolve arrow, a type and inertia, and names them', () => {
		expect(pipelineBlockers(MAP, 'Teapot')).toEqual(['evolve']);
		expect(pipelineBlockers(MAP, 'Induction')).toEqual(['method', 'inertia']);
		expect(pipelineBlockers(MAP, 'Power')).toEqual([]);
		expect(pipelineBlockers(MAP, 'Electric Kettle')).toEqual([]);
		expect(pipelineBlockers(MAP, 'Public')).toEqual([]);
		expect(() => moveIntoPipeline(MAP, 'Kettle', 'Induction')).toThrow('"Induction" has a type and inertia, which a pipeline component cannot have.');
		expect(() => moveIntoPipeline(MAP, 'Kettle', 'Teapot')).toThrow(/an evolve arrow/);
		expect(describeBlockers(['evolve', 'method', 'inertia'])).toBe('an evolve arrow, a type and inertia');
	});

	it('clears them in one step, inertia position included, and the move then works', async () => {
		const cleared = clearPipelineBlockers(MAP, 'Induction');
		expect(cleared).toContain('component Induction [0.25, 0.75]\ncomponent Teapot');
		expect(cleared).not.toContain('mp-inertia');
		expect(pipelineBlockers(cleared, 'Induction')).toEqual([]);
		const out = moveIntoPipeline(cleared, 'Kettle', 'Induction');
		expect((await el(out, 'Induction')).pipeline).toBe('Kettle');
		const t = moveIntoPipeline(clearPipelineBlockers(MAP, 'Teapot'), 'Kettle', 'Teapot');
		expect(t).not.toContain('evolve Teapot');
		await model(t);
		expect(clearPipelineBlockers(MAP, 'Power')).toBe(MAP);
	});
});

describe('takeOutOfPipeline', () => {
	it('declares it after the block at the parent visibility, evolution and label kept', async () => {
		const out = takeOutOfPipeline(MAP, 'Electric Kettle');
		expect(out).toContain('pipeline Kettle {\n  component Campfire Kettle [0.15]\n}\ncomponent Electric Kettle [0.43, 0.62] label [5, 20]');
		expect(await el(out, 'Electric Kettle')).toMatchObject({ visibility: 0.43, evolution: 0.62, label: [5, 20] });
		expect((await el(out, 'Electric Kettle')).pipeline).toBeUndefined();
		expect(pipelineParentOf(out, 'Electric Kettle')).toBeNull();
	});

	it('the last one out takes the block with it, the parent stays', async () => {
		const out = takeOutOfPipeline(takeOutOfPipeline(MAP, 'Electric Kettle'), 'Campfire Kettle');
		expect(out).not.toContain('pipeline');
		expect(out).toContain('evolve Teapot 0.70\ncomponent Campfire Kettle [0.43, 0.15]\ncomponent Electric Kettle [0.43, 0.62] label [5, 20]');
		const m = await model(out);
		expect(m.pipelines).toEqual([]);
		expect(m.elements.find(e => e.name === 'Kettle')).toBeDefined();
	});

	it('in and out again leaves the same map, apart from where the declaration stands', async () => {
		const back = takeOutOfPipeline(moveIntoPipeline(MAP, 'Kettle', 'Gas Stove'), 'Gas Stove');
		expect(back).toContain('component "Gas Stove" [0.43, 0.20] label [-30, 12]');
		const lines = MAP.split('\n').filter(l => !l.startsWith('component "Gas Stove"'));
		lines.splice(lines.indexOf('}') + 1, 0, 'component "Gas Stove" [0.43, 0.20] label [-30, 12]');
		expect(back).toBe(lines.join('\n'));
		await model(back);
	});

	it('refuses a component at the top level', () => {
		expect(() => takeOutOfPipeline(MAP, 'Power')).toThrow(/not in a pipeline/);
		expect(() => takeOutOfPipeline(MAP, 'Public')).toThrow(/not in a pipeline/);
	});
});

describe('speed', () => {
	it('moves in and out in linear time on a large map', () => {
		const decls = Array.from({ length: 5000 }, (_, i) => `component N${i} [0.${String(i % 90 + 10)}, 0.5]`).join('\n');
		const links = Array.from({ length: 5000 }, (_, i) => `N${i} -> N${(i + 1) % 5000}`).join('\n');
		const src = `wardley-beta\n${decls}\n${links}\npipeline N0 {\n  component X [0.5]\n}`;
		const t = performance.now();
		const out = moveIntoPipeline(src, 'N0', 'N1');
		takeOutOfPipeline(out, 'N1');
		pipelineBlockers(src, 'N2');
		expect(performance.now() - t).toBeLessThan(timeLimit(500));
	});
});
