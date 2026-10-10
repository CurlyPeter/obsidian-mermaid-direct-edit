import { describe, expect, it } from 'vitest';
import { EditError, deleteNote, getAnnotation, setAnnotationsBoxPosition, editBlocker, freeSpot, getPosition, inertiaPositions, isWardley, locateBlock, mermaidBlocks, nameSpans, rename, setMethod, setPosition, setTitle } from './wardley-text';
import { SourceRegistry } from './wardley-render';

/** Findings of the security review on 0.12.0 (DEV.md → 0.13.0). */

const fast = (f: () => unknown, ms = 250) => {
	const t = performance.now();
	try { f(); } catch { /* only the time counts */ }
	expect(performance.now() - t).toBeLessThan(ms);
};
const pad = (n: number) => ' '.repeat(n);

describe('F1/F2: no super-linear parsing of a crafted source', () => {
	it('a long mp-inertia comment is read in linear time', () => {
		fast(() => inertiaPositions(`wardley-beta\n%% mp-inertia a${pad(30000)}x`));
	});

	it('a position with a long unterminated value is read in linear time', () => {
		fast(() => getPosition(`wardley-beta\ncomponent B [a,${pad(3000)}`, 'B'));
		fast(() => freeSpot(`wardley-beta\ncomponent B [a,${pad(3000)}`, 'component'));
	});

	it('a long bare name without a position is read in linear time', () => {
		fast(() => nameSpans(`component x${pad(45000)}y`));
		fast(() => nameSpans(`A${pad(45000)}B -> C`));
	});

	it('the annotation parsers (0.17.0) read in linear time', () => {
		fast(() => getAnnotation(`wardley-beta\nannotation 1,[0.1, 0.1] "${pad(30000)}`, 1));
		fast(() => getAnnotation(`wardley-beta\nannotation 1,[${pad(30000)}0.1,${pad(30000)}`, 1));
		fast(() => freeSpot(`wardley-beta\n${'annotation 1,[0.1, 0.1] "x"\n'.repeat(2000)}`, 'component'));
		fast(() => setAnnotationsBoxPosition(`wardley-beta\nannotations [${pad(30000)}`, 0.1, 0.1));
	});

	it('the parsers added for the model (0.15.0) read in linear time', () => {
		fast(() => setMethod(`wardley-beta\ncomponent B [0.1, 0.1]${pad(30000)}label [${pad(30000)}`, 'B', 'buy'));
		fast(() => setMethod(`wardley-beta\ncomponent B [0.1, 0.1] label [1, 1]${pad(30000)}(${pad(30000)}`, 'B', null));
		fast(() => setTitle(`wardley-beta\ntitle${pad(60000)}x`, 'T'));
		fast(() => deleteNote(`wardley-beta\nnote ${pad(30000)}"${pad(30000)}`, 'x'));
		fast(() => isWardley(`${pad(60000)}wardley-beta`));
		fast(() => mermaidBlocks('```mermaid\n' + `${'`'.repeat(3)}x\n`.repeat(5000)));
	});

	it('parsing still reads the same values', () => {
		expect(inertiaPositions('wardley-beta\n%% mp-inertia Hot Water   0.85  ').get('Hot Water')).toBe(0.85);
		expect(inertiaPositions('wardley-beta\n%% mp-inertia "Käse" 0.3').get('Käse')).toBe(0.3);
		expect(inertiaPositions('wardley-beta\n%% mp-inertia 0.3').size).toBe(0);
		expect(getPosition('wardley-beta\ncomponent A [ 0.4 , 0.6 ] label [1, 2]', 'A')).toEqual({ visibility: 0.4, evolution: 0.6 });
		expect(getPosition('wardley-beta\npipeline P {\n  component C [0.7]\n}\ncomponent P [0.5, 0.5]', 'C')).toEqual({ evolution: 0.7 });
		expect(setPosition('wardley-beta\ncomponent A [ 0.4 , 0.6 ]', 'A', 0.5, 0.25)).toBe('wardley-beta\ncomponent A [ 0.50 , 0.25 ]');
		expect(() => getPosition('wardley-beta\ncomponent A [ ]', 'A')).toThrow();
	});
});

describe('editBlocker: maps that render but are not edited graphically', () => {
	const ok = 'wardley-beta\ncomponent A [0.5, 0.5]';
	it('accepts an ordinary map', () => expect(editBlocker(ok)).toBeNull());
	it('refuses the 0-100 scale', () => expect(editBlocker('wardley-beta\ncomponent A [50, 50]')).toMatch(/0-100/));
	it('refuses a very long line', () => expect(editBlocker(`${ok}\n%% ${'x'.repeat(2000)}`)).toMatch(/long/));
	it('refuses a very large source', () => expect(editBlocker(`${ok}\n${'%% x\n'.repeat(20000)}`)).toMatch(/large/));
	it('refuses a multi-line accDescr block, whose lines would read as declarations', () => {
		expect(editBlocker(`${ok}\naccDescr {\ncomponent A [0.1, 0.1]\n}`)).toMatch(/accDescr/);
		expect(editBlocker(`${ok}\naccDescr: one line`)).toBeNull();
	});
});

describe('F3: writes go into a fenced mermaid block of its own only', () => {
	const src = 'wardley-beta\ncomponent A [0.5, 0.5]';
	const block = (s: string, fence = '```') => `${fence}mermaid\n${s}\n${fence}`;

	it('finds the body of the one mermaid block', () => {
		const text = `# T\n\n${block(src)}\n`;
		expect(locateBlock(text, src)).toBe(text.indexOf(src));
		const tilde = `${block(src, '~~~~')}`;
		expect(locateBlock(tilde, src)).toBe(tilde.indexOf(src));
	});

	it('ignores the same text elsewhere in the note', () => {
		const text = `\`\`\`text\n${src}\n\`\`\`\n\n${block(src)}\n\n${src}\n`;
		expect(locateBlock(text, src)).toBe(text.indexOf(`mermaid\n${src}`) + 'mermaid\n'.length);
	});

	it('ignores a mermaid fence shown inside another code block', () => {
		const text = `\`\`\`\`markdown\n${block(src)}\n\`\`\`\`\n`;
		expect(locateBlock(text, src)).toMatch(/own/);
	});

	it('refuses a map inside a callout, even when its text matches a prefix', () => {
		const callout = `> [!note]\n> \`\`\`mermaid\n> wardley-beta\n> \`\`\`\n`;
		expect(locateBlock(callout, 'wardley-beta')).toMatch(/own/);
	});

	it('refuses a map that changed or occurs twice', () => {
		expect(locateBlock(block('wardley-beta'), src)).toMatch(/changed/);
		expect(locateBlock(`${block(src)}\n${block(src)}`, src)).toMatch(/more than once/);
	});
});

describe('F6: the source registry is bounded', () => {
	it('reuses the key for identical text', () => {
		const r = new SourceRegistry();
		expect(r.register('wardley-beta\nA')).toBe(r.register('wardley-beta\nA'));
		expect(r.register('wardley-beta\nA')).not.toBe(r.register('wardley-beta\nB'));
	});
});

describe('names cannot inject statements', () => {
	it('a rename stays one statement', () => {
		const src = 'wardley-beta\ncomponent A [0.5, 0.5]';
		expect(() => rename(src, 'A', 'x\ncomponent Y [0.1, 0.1]')).toThrow(EditError);
		expect(rename(src, 'A', 'x" [0.1, 0.1] -> B')).toBe(`wardley-beta\ncomponent 'x" [0.1, 0.1] -> B' [0.5, 0.5]`);
	});
});
