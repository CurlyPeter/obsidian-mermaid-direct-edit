/**
 * Classes on Wardley maps (`%% class <target> <class>`, `%% classDef`), the plugin's interim form
 * of Mermaid's `class` statement (DEV.md → "Classes for wardley-beta"). Every edit is parsed by
 * the real Mermaid wardley parser and read back through the model, so a class line that would
 * draw nothing (a stale name, a dropped link) shows up as an error here.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import { applyModel, readModel } from './wardley-model';
import {
	EditError, classDefs, classMarkers, deleteElement, deletePipeline, getClasses, relink, rename, setClass, setClasses, unlink,
} from './wardley-text';

const MAP = [
	'wardley-beta',
	'anchor Public [0.95, 0.62]',
	'component Cup of Tea [0.79, 0.61] label [10, -8]',
	'component Hot Water [0.52, 0.80]',
	'component Staff [0.70, 0.40]',
	'component Kettle [0.30, 0.40] (inertia)',
	'component Power [0.10, 0.70]',
	'',
	'Public -> Cup of Tea',
	'Cup of Tea -> Hot Water',
	'Hot Water -> Kettle',
	'Kettle +> Power; needs',
	'Staff -.-> Kettle',
	'',
	'pipeline Kettle {',
	'  component Campfire Kettle [0.15]',
	'  component Electric Kettle [0.62]',
	'}',
	'',
	'%% class Kettle highlight',
	'%% class Kettle -> Power highlight',
	'',
	'annotation 1,[0.49, 0.45] "Kettle evolves"',
	'annotations [0.97, 0.03]',
].join('\n');

const read = (src: string) => readModel(src, parse);
/** Classes per element and link as the model reads them, plus its errors: what a consumer sees. */
const classesOf = async (src: string) => {
	const m = await read(src);
	return {
		elements: Object.fromEntries(m.elements.filter(e => e.classes).map(e => [e.name, e.classes])),
		links: Object.fromEntries(m.links.filter(l => l.classes).map(l => [`${l.from} ${l.kind} ${l.to}`, l.classes])),
		errors: m.errors.map(e => `${e.line}: ${e.message}`),
	};
};
const classLines = (src: string) => src.split('\n').filter(l => /^\s*%%\s*class\s/.test(l));

describe('reading class lines', () => {
	it('reads element and link targets, in either written order, quoted or bare', () => {
		const src = 'wardley-beta\n%% class Kettle highlight\n%% class Power -> Kettle highlight\n%%class "Cup of Tea", \'say "x"\' , A -> "B.C" muted';
		expect(classMarkers(src)).toEqual([
			{ line: 2, cls: 'highlight', targets: ['Kettle'] },
			{ line: 3, cls: 'highlight', targets: [['Power', 'Kettle']] },
			{ line: 4, cls: 'muted', targets: ['Cup of Tea', 'say "x"', ['A', 'B.C']] },
		]);
		expect(getClasses(MAP, ['Power', 'Kettle'])).toEqual(['highlight']);
		expect(getClasses(MAP, 'Kettle')).toEqual(['highlight']);
		expect(getClasses(MAP, 'Power')).toEqual([]);
	});

	it('names what is wrong with a line instead of guessing', () => {
		const problems = classMarkers('wardley-beta\n%% class highlight\n%% class Kettle high!light\n%% class Kettle, , Power highlight\n%% class -> Power highlight')
			.map(m => m.problem);
		expect(problems[0]).toMatch(/no target/);
		expect(problems[1]).toMatch(/not a class name/);
		expect(problems[2]).toMatch(/empty name/);
		expect(problems[3]).toMatch(/empty name/);
	});

	it('leaves other comments alone', () => {
		expect(classMarkers('wardley-beta\n%% classDef highlight stroke:#8000F0\n%% mp-inertia Kettle 0.4\n%% a class of its own')).toEqual([]);
	});

	it('reads classDefs, keeping only colours and plain numbers', () => {
		const defs = classDefs('wardley-beta\n%% classDef highlight stroke:#8000F0,stroke-width:5px, color: red;\n%% classDef bad fill:url(https://x.test/a),stroke:expression(1),stroke-width:1e9,constructor:x,stroke-dasharray:5 5');
		expect(defs[0]).toEqual({ line: 2, name: 'highlight', style: { stroke: '#8000F0', 'stroke-width': '5px', color: 'red' }, rejected: [] });
		expect(defs[1].style).toEqual({ 'stroke-dasharray': '5 5' });
		expect(defs[1].rejected).toEqual(['fill:url(https://x.test/a)', 'stroke:expression(1)', 'stroke-width:1e9', 'constructor:x']);
	});
});

describe('setClass', () => {
	it('adds a line after the last class line, the target written as the grammar needs', async () => {
		let s = setClass(MAP, 'Cup of Tea', 'highlight', true);
		s = setClass(s, ['Hot Water', 'Kettle'], 'highlight', true);
		s = setClass(s, 'Public', 'muted', true);
		expect(classLines(s)).toEqual([
			'%% class Kettle highlight', '%% class Kettle -> Power highlight', '%% class Cup of Tea highlight',
			'%% class Hot Water -> Kettle highlight', '%% class Public muted',
		]);
		expect(await classesOf(s)).toEqual({
			elements: { Public: ['muted'], 'Cup of Tea': ['highlight'], Kettle: ['highlight'] },
			links: { 'Hot Water -> Kettle': ['highlight'], 'Kettle +> Power': ['highlight'] },
			errors: [],
		});
	});

	it('without class lines, adds the line at the end of the map, before trailing blank lines', () => {
		const s = setClass('wardley-beta\ncomponent "A.B" [0.5, 0.5]\n\n', 'A.B', 'highlight', true);
		expect(s).toBe('wardley-beta\ncomponent "A.B" [0.5, 0.5]\n%% class "A.B" highlight\n\n');
	});

	it('removes a target from a list and a line that is left empty', async () => {
		const src = MAP.replace('%% class Kettle highlight', '%% class Staff, Kettle, Public highlight');
		let s = setClass(src, 'Kettle', 'highlight', false);
		expect(classLines(s)).toEqual(['%% class Staff, Public highlight', '%% class Kettle -> Power highlight']);
		s = setClass(s, ['Power', 'Kettle'], 'highlight', false);
		expect(classLines(s)).toEqual(['%% class Staff, Public highlight']);
		expect((await classesOf(s)).errors).toEqual([]);
	});

	it('is a no-op when the class is already as asked', () => {
		expect(setClass(MAP, 'Kettle', 'highlight', true)).toBe(MAP);
		expect(setClass(MAP, 'Staff', 'highlight', false)).toBe(MAP);
	});

	it('refuses an undeclared element, a link that does not exist and a bad class name', () => {
		expect(() => setClass(MAP, 'Teapot', 'highlight', true)).toThrow(EditError);
		expect(() => setClass(MAP, ['Public', 'Power'], 'highlight', true)).toThrow(EditError);
		expect(() => setClass(MAP, 'Kettle', 'high light', true)).toThrow(EditError);
	});

	it('setClasses makes the list exact', async () => {
		let s = setClasses(MAP, 'Kettle', ['muted', 'new']);
		expect(getClasses(s, 'Kettle')).toEqual(['muted', 'new']);
		s = setClasses(s, 'Kettle', []);
		expect(getClasses(s, 'Kettle')).toEqual([]);
		expect((await classesOf(s)).errors).toEqual([]);
	});
});

describe('edits keep the class lines consistent', () => {
	it('rename rewrites element and link targets, quoting where needed', async () => {
		const src = MAP.replace('%% class Kettle highlight', '%% class Staff,  Kettle highlight');
		const s = rename(src, 'Kettle', 'Käse Kettle');
		expect(classLines(s)).toEqual(['%% class Staff,  "Käse Kettle" highlight', '%% class "Käse Kettle" -> Power highlight']);
		expect(await classesOf(s)).toEqual({
			elements: { Staff: ['highlight'], 'Käse Kettle': ['highlight'] },
			links: { 'Käse Kettle +> Power': ['highlight'] },
			errors: [],
		});
	});

	it('deleting an element drops its classes and those of its links, nothing else', async () => {
		const src = MAP.replace('%% class Kettle highlight', '%% class Staff, Kettle highlight') + '\n%% class Kettle -> Staff, Cup of Tea -> Hot Water highlight';
		const s = deleteElement(src, 'Staff');
		expect(classLines(s)).toEqual(['%% class Kettle highlight', '%% class Kettle -> Power highlight', '%% class Cup of Tea -> Hot Water highlight']);
		expect((await classesOf(s)).errors).toEqual([]);
	});

	it('removing a pipeline drops the classes of its components and their links', async () => {
		const src = `${MAP}\n%% class Electric Kettle highlight\nCampfire Kettle -> Power\n%% class Power -> Campfire Kettle highlight`;
		const s = deletePipeline(src, 'Kettle');
		expect(classLines(s)).toEqual(['%% class Kettle highlight', '%% class Kettle -> Power highlight']);
		expect((await classesOf(s)).errors).toEqual([]);
		// The last component of a pipeline takes the pipeline, and its class, with it.
		const one = deleteElement(deleteElement(src, 'Campfire Kettle'), 'Electric Kettle');
		expect(classLines(one)).toEqual(['%% class Kettle highlight', '%% class Kettle -> Power highlight']);
		expect((await classesOf(one)).errors).toEqual([]);
	});

	it('unlink drops the class of the link', async () => {
		const s = unlink(MAP, 'Power', 'Kettle');
		expect(classLines(s)).toEqual(['%% class Kettle highlight']);
		expect((await classesOf(s)).errors).toEqual([]);
	});

	it('a re-linked link keeps its class', async () => {
		const s = relink(MAP, 'Kettle', 'Power', 'Power', 'Cup of Tea');
		expect(s).toContain('Kettle +> Cup of Tea; needs');
		expect(classLines(s)).toEqual(['%% class Kettle highlight', '%% class Kettle -> Cup of Tea highlight']);
		expect((await classesOf(s)).links).toEqual({ 'Kettle +> Cup of Tea': ['highlight'] });
	});
});

describe('the model', () => {
	it('wardley-read reports classes, classDefs and every line that sets nothing', async () => {
		const src = `${MAP}\n%% classDef highlight stroke:#8000F0,fill:url(x)\n%% class Teapot highlight\n%% class Public -> Power highlight\n%% class Staff`;
		const m = await read(src);
		expect(m.elements.find(e => e.name === 'Kettle')?.classes).toEqual(['highlight']);
		expect(m.links.find(l => l.from === 'Kettle')?.classes).toEqual(['highlight']);
		expect(m.elements.find(e => e.name === 'Staff')?.classes).toBeUndefined();
		expect(m.classDefs).toEqual([{ name: 'highlight', style: { stroke: '#8000F0' }, line: 25 }]);
		expect(m.errors.map(e => e.line)).toEqual([25, 26, 27, 28]);
		expect(m.errors.map(e => e.message).join('\n')).toMatch(/fill:url\(x\).*\n.*Teapot.*\n.*"Public" and "Power".*\n.*no target/);
	});

	it('wardley-apply sets classes on elements and links, and the read model is a no-op', async () => {
		const m = await read(MAP);
		expect((await applyModel(MAP, m, parse)).changes).toEqual([]);
		const target = {
			elements: m.elements.map(e => (e.name === 'Kettle' ? { ...e, classes: [] } : e.name === 'Staff' ? { ...e, classes: ['highlight'] } : e))
				.concat([{ name: 'Tea', kind: 'component', visibility: 0.63, evolution: 0.83, line: 0, classes: ['highlight'] }]),
			links: m.links.map(l => (l.from === 'Staff' ? { ...l, classes: ['highlight'] } : l))
				.concat([{ from: 'Cup of Tea', to: 'Tea', kind: '->', line: 0, classes: ['muted'] }]),
		};
		const r = await applyModel(MAP, target, parse);
		expect(r.conflicts).toEqual([]);
		expect(r.changes.map(c => c.what)).toEqual(['component Staff classes', 'component Kettle classes', 'component Tea', 'link Staff -.-> Kettle classes', 'link Cup of Tea -> Tea']);
		expect(await classesOf(r.source)).toEqual({
			elements: { Staff: ['highlight'], Tea: ['highlight'] },
			links: { 'Kettle +> Power': ['highlight'], 'Staff -.-> Kettle': ['highlight'], 'Cup of Tea -> Tea': ['muted'] },
			errors: [],
		});
		expect((await applyModel(r.source, await read(r.source), parse)).changes).toEqual([]);
	});

	it('wardley-apply refuses a class that is not a class name, a name over 40 characters, more than 8 classes', async () => {
		for (const classes of [['a b'], ['x'.repeat(41)], Array.from({ length: 9 }, (_, i) => `c${i}`)]) {
			await expect(applyModel(MAP, { elements: [{ name: 'Kettle', evolution: 0.4, classes }] }, parse)).rejects.toThrow(/class names/);
		}
		const eight = Array.from({ length: 8 }, (_, i) => `c${i}`);
		const m = await read(MAP);
		const r = await applyModel(MAP, { elements: m.elements.map(e => (e.name === 'Kettle' ? { ...e, classes: eight } : e)) }, parse);
		expect([r.conflicts, getClasses(r.source, 'Kettle')]).toEqual([[], eight]);
	});

	it('security review 0.19.0 (F-B): a link kind cannot carry a line break, so no fence reaches the note', async () => {
		const kind = "+'\n```\n```dataviewjs\nconsole.log(1)//'>";
		await expect(applyModel(MAP, { links: [{ from: 'Kettle', to: 'Staff', kind }] }, parse)).rejects.toThrow(/not an arrow/);
	});

	it('wardley-read stays linear with many distinct classes on one element', async () => {
		const src = `${MAP}\n${Array.from({ length: 40000 }, (_, i) => `%% class Staff c${i}`).join('\n')}`;
		const t = performance.now();
		const m = await read(src);
		expect(performance.now() - t).toBeLessThan(1500);
		expect(m.elements.find(e => e.name === 'Staff')?.classes?.length).toBe(40000);
	});
});
