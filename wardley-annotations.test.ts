/**
 * Annotation edits (0.17.0), checked against the real Mermaid 12.1 wardley parser
 * (`@mermaid-js/parser`): the parse tree must hold what the edit claims to have written.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import {
	addAnnotation, deleteAnnotation, freeSpot, getAnnotation, setAnnotationPosition, setAnnotationText, setAnnotationsBoxPosition,
} from './wardley-text';

const ast = async (src: string) => (await parse('wardley', src + '\n')) as any;

const MAP = [
	'wardley-beta',
	'component Kettle [0.43, 0.35]',
	'',
	'annotations [0.98, 0.03]',
	'annotation 1,[0.48, 0.38] "Standardising power"',
	"annotation 2, [ 0.85 , 0.71 ]  'Hot water is obvious'  %% keep me",
	'note "annotation 1,[0.10, 0.10] \\"x\\"" [0.30, 0.49]',
].join('\n');

describe('annotations', () => {
	it('reads the text of either quote style', () => {
		expect(getAnnotation(MAP, 1)).toBe('Standardising power');
		expect(getAnnotation(MAP, 2)).toBe('Hot water is obvious');
	});

	it('moves only the position and keeps spacing, text and comment', async () => {
		const out = setAnnotationPosition(MAP, 2, 0.5, 0.25);
		expect(out.split('\n')[5]).toBe("annotation 2, [ 0.50 , 0.25 ]  'Hot water is obvious'  %% keep me");
		const a = (await ast(out)).annotation.find((x: any) => x.number === 2);
		expect([a.x, a.y]).toEqual([0.5, 0.25]);
		expect(out.split('\n').filter((l, i) => l !== MAP.split('\n')[i])).toHaveLength(1);
	});

	it('replaces the text, written in double quotes', async () => {
		const out = setAnnotationText(MAP, 2, "Kettle's water");
		expect(out.split('\n')[5]).toBe(`annotation 2, [ 0.85 , 0.71 ]  "Kettle's water"  %% keep me`);
		expect((await ast(out)).annotation.find((x: any) => x.number === 2).text).toBe("Kettle's water");
		expect(() => setAnnotationText(MAP, 1, 'say "hi"')).toThrow(/double quotes/);
		expect(() => setAnnotationText(MAP, 1, '  ')).toThrow(/empty/);
		expect(setAnnotationText(MAP, 1, 'two\nlines')).toContain('"two lines"');
	});

	it('deletes one annotation, and the box with the last one', async () => {
		const one = deleteAnnotation(MAP, 1);
		expect(one).not.toContain('Standardising power');
		expect(one).toContain('annotations [0.98, 0.03]');
		const none = deleteAnnotation(one, 2);
		expect(none).not.toMatch(/^annotations?\b/m);
		const tree = await ast(none);
		expect(tree.annotation).toHaveLength(0);
		expect(tree.annotations).toHaveLength(0);
		expect(tree.notes).toHaveLength(1);  // a note that only looks like an annotation stays
	});

	it('adds the next number after the last annotation', async () => {
		const out = addAnnotation(MAP, 'New one', 0.2, 0.6);
		expect(out.split('\n')[6]).toBe('annotation 3,[0.20, 0.60] "New one"');
		expect((await ast(out)).annotation.map((a: any) => a.number)).toEqual([1, 2, 3]);
	});

	it('adds the box when a map has none, keeping trailing blank lines', async () => {
		const out = addAnnotation('wardley-beta\ncomponent A [0.50, 0.50]\n\n', 'First', 0.4, 0.4);
		expect(out).toBe('wardley-beta\ncomponent A [0.50, 0.50]\nannotations [0.97, 0.03]\nannotation 1,[0.40, 0.40] "First"\n\n');
		const tree = await ast(out);
		expect(tree.annotations).toHaveLength(1);
		expect(tree.annotation[0].text).toBe('First');
	});

	it('moves the box', async () => {
		const out = setAnnotationsBoxPosition(MAP, 0.2, 0.7);
		expect(out.split('\n')[3]).toBe('annotations [0.20, 0.70]');
		const b = (await ast(out)).annotations[0];
		expect([b.x, b.y]).toEqual([0.2, 0.7]);
		expect(() => setAnnotationsBoxPosition('wardley-beta', 0.1, 0.1)).toThrow(/no annotations box/);
	});

	it('refuses unknown and duplicated numbers', () => {
		expect(() => getAnnotation(MAP, 7)).toThrow(/No annotation 7/);
		const twice = MAP + '\nannotation 1,[0.10, 0.10] "again"';
		expect(() => setAnnotationPosition(twice, 1, 0.1, 0.1)).toThrow(/2 times/);
	});

	it('keeps new elements off annotation circles', () => {
		const at = freeSpot('wardley-beta\nannotation 1,[0.50, 0.50] "centre"', 'component');
		expect(Math.hypot(at.visibility - 0.5, at.evolution - 0.5)).toBeGreaterThanOrEqual(0.08);
	});
});
