/**
 * Regression tests for the findings of the 2026-10-10 code review, checked against the real
 * Mermaid 12.1 wardley parser (`@mermaid-js/parser`), not only against expected strings.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import {
	addElement, addEvolve, addToPipeline, deleteElement, deletePipeline, defaultEvolveTarget, formatName, freeSpot,
	getLink, getMethod, hasInertia, type Method, nextPipelineEvolution, pipelineParents, rename, setInertia, setLink, setMethod,
	usesPercentScale,
} from './wardley-text';
import { locateBlock } from './blocks';

const parses = async (src: string) => {
	try { await parse('wardley', src + '\n'); return true; } catch { return false; }
};

const BASE = 'wardley-beta\ncomponent K [0.50, 0.40]\ncomponent T [0.80, 0.70]\nK -> T';

describe('review #3: names starting with a lowercase keyword', () => {
	it('quotes them, and the result parses', async () => {
		for (const n of ['builder', 'buyer', 'marketing', 'notes', 'labels', 'sizeable', 'evolver', 'pipeline x', 'title', 'annotations']) {
			expect(formatName(n)).toBe(`"${n}"`);
			expect(await parses(addElement(BASE, 'component', n, 0.3, 0.3))).toBe(true);
		}
	});
	it('keeps capitalised and ordinary names bare', () => {
		for (const n of ['Builder', 'Market', 'Tea', 'Cup of Tea', 'end-user']) expect(formatName(n)).toBe(n);
	});
	it('renames to such a name with a parsable result', async () => {
		expect(await parses(rename(BASE, 'K', 'notes'))).toBe(true);
	});
});

describe('review #4: maps on the 0-100 scale', () => {
	it('are detected (they are rendered but not editable)', () => {
		expect(usesPercentScale('wardley-beta\ncomponent A [50, 70]')).toBe(true);
		expect(usesPercentScale('wardley-beta\nnote "x" [10.5, 0.2]')).toBe(true);
		expect(usesPercentScale(BASE)).toBe(false);
		expect(usesPercentScale('wardley-beta\ncomponent "a [99, 99]" [0.5, 0.5]')).toBe(false);
	});
});

describe('review #9: no orphan evolve lines', () => {
	const PIPE = addToPipeline(addToPipeline(BASE, 'K', 'A', 0.6), 'K', 'B', 0.3) + '\nevolve A 0.9\nevolve B 0.5';
	it('deletePipeline removes the children\'s evolve arrows', async () => {
		const out = deletePipeline(PIPE, 'K');
		expect(out).not.toMatch(/evolve (A|B)/);
		expect(await parses(out)).toBe(true);
	});
	it('deleting the last child removes its evolve arrow with the block', () => {
		expect(deleteElement(deleteElement(PIPE, 'A'), 'B')).not.toMatch(/evolve/);
	});
});

describe('review #11: direction is not read from an inline label', () => {
	it('reads `+\'x<y\'>` as forward and keeps it forward when only the label changes', () => {
		const src = "wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.2, 0.2]\nA +'x<y'> B";
		const link = getLink(src, 'A', 'B');
		expect(link).toMatchObject({ kind: 'forward', label: 'x<y' });
		expect(setLink(src, 'A', 'B', link.kind, 'z')).toContain('A +> B; z');
	});
});

describe('review #12: braces inside quoted names', () => {
	it('do not change where a declaration counts as top level', async () => {
		const src = 'wardley-beta\ncomponent "a{b" [0.5, 0.5]\ncomponent Z [0.2, 0.2]';
		const out = addEvolve(src, 'Z', 0.6);
		expect(out.split('\n').indexOf('evolve Z 0.60')).toBeGreaterThan(out.split('\n').indexOf('component Z [0.2, 0.2]'));
		expect(await parses(out)).toBe(true);
	});
});

describe('helpers moved out of the editor', () => {
	it('locateBlock finds the single occurrence or says why not', () => {
		expect(locateBlock('x\n```mermaid\nAB\n```\ny', 'AB')).toBe(13);
		expect(locateBlock('x', 'AB')).toMatch(/changed/);
		expect(locateBlock('```mermaid\nAB\n```\n```mermaid\nAB\n```', 'AB')).toMatch(/more than once/);
	});
	it('pipelineParents lists parents in source order, quotes stripped', () => {
		expect(pipelineParents('wardley-beta\npipeline K {\n}\npipeline "Käse" {\n}')).toEqual(['K', 'Käse']);
	});
	it('defaultEvolveTarget and nextPipelineEvolution', () => {
		expect(defaultEvolveTarget(BASE, 'K')).toBeCloseTo(0.6);
		expect(defaultEvolveTarget('wardley-beta\ncomponent X [0.5, 0.9]', 'X')).toBe(1);
		expect(nextPipelineEvolution(BASE, 'K')).toBe(0.4);
		expect(nextPipelineEvolution(addToPipeline(BASE, 'K', 'A', 0.6), 'K')).toBeCloseTo(0.7);
	});
	it('freeSpot avoids components, notes and accelerators', () => {
		const src = 'wardley-beta\ncomponent A [0.50, 0.50]\nnote "n" [0.50, 0.60]\naccelerator X [0.50, 0.40]';
		const s = freeSpot(src, 'component');
		for (const [v, e] of [[0.5, 0.5], [0.5, 0.6], [0.5, 0.4]]) expect(Math.hypot(s.visibility - v, s.evolution - e)).toBeGreaterThanOrEqual(0.08);
		expect(freeSpot(src, 'anchor').visibility).toBe(0.95);
	});
});

describe('the element dialog saves everything in one edit (0.18.0)', () => {
	const methods: (Method | null)[] = [null, 'build', 'buy', 'outsource', 'market'];
	const starts = [
		'component Kettle [0.40, 0.35]',
		'component Kettle [0.40, 0.35] label [-20, 10]',
		'component Kettle [0.40, 0.35] (build) (inertia)',
		'component Kettle [0.40, 0.35] label [5, 5] (market)',
	];
	it.each(starts)('inertia, type and rename together on %j parse and read back', async start => {
		for (const inertia of [false, true]) {
			for (const method of methods) {
				for (const newName of [null, 'Electric kettle']) {
					let s = `wardley-beta\n${start}\nanchor Tea [0.95, 0.50]\nTea -> Kettle\nevolve Kettle 0.60`;
					// As the dialog does: only what changed, the rename last.
					if (hasInertia(s, 'Kettle') !== inertia) s = setInertia(s, 'Kettle', inertia);
					if (getMethod(s, 'Kettle') !== method) s = setMethod(s, 'Kettle', method);
					if (newName) s = rename(s, 'Kettle', newName);
					const name = newName ?? 'Kettle';
					expect([start, inertia, method, newName, await parses(s)]).toEqual([start, inertia, method, newName, true]);
					expect([start, inertia, method, hasInertia(s, name), getMethod(s, name)]).toEqual([start, inertia, method, inertia, method]);
				}
			}
		}
	});
});
