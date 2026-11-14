import { describe, expect, it } from 'vitest';
import { timeLimit } from './test-timing';
import { blockAt, followBlock, lineEdits, mermaidBlocks, narrowed } from './blocks';

const note = (...bodies: string[]) => bodies.map(b => '```mermaid\n' + b + '\n```').join('\n\ntext\n\n');
const bodiesOf = (text: string) => mermaidBlocks(text).map(b => b.body);

describe('followBlock (the zoom follows its block through edits)', () => {
	it('stays on its block when that block is edited', () => {
		const after = bodiesOf(note('a', 'B changed', 'c'));
		expect(followBlock(after, 3, 1, 'b')).toBe(1);
	});
	it('stays on its block when another block is edited', () => {
		const after = bodiesOf(note('a changed', 'b', 'c'));
		expect(followBlock(after, 3, 1, 'b')).toBe(1);
	});
	it('finds its block again when one is added or removed before it', () => {
		expect(followBlock(bodiesOf(note('new', 'a', 'b', 'c')), 3, 1, 'b')).toBe(2);
		expect(followBlock(bodiesOf(note('b', 'c')), 3, 1, 'b')).toBe(0);
	});
	it('takes the identical block nearest to where it was', () => {
		expect(followBlock(bodiesOf(note('x', 'b', 'y', 'b', 'z', 'b')), 5, 3, 'b')).toBe(3);
		expect(followBlock(bodiesOf(note('b', 'q', 'b', 'w')), 5, 0, 'b')).toBe(0);
	});
	it('answers null when its block is gone', () => {
		expect(followBlock(bodiesOf(note('a', 'c')), 3, 1, 'b')).toBeNull();
		expect(followBlock([], 1, 0, 'b')).toBeNull();
	});
	it('answers null for an index outside the note even with the same count', () => {
		expect(followBlock(['a'], 1, 3, 'a')).toBe(0);
		expect(followBlock(['x'], 1, 3, 'a')).toBeNull();
	});
});

describe('blockAt (the zoom finds a drawing by where it sits in the note)', () => {
	const text = note('a', 'bb', 'ccc');
	const blocks = mermaidBlocks(text);
	it('knows each block from its first fence to its last, and answers on its opening fence line', () => {
		blocks.forEach((b, i) => {
			expect(text.slice(b.start, b.from)).toBe('```mermaid\n');
			expect(text.slice(b.from + b.body.length, b.end)).toBe('\n```');
			expect(blockAt(blocks, b.start)).toBe(i);
			expect(blockAt(blocks, b.from - 1)).toBe(i);
		});
	});
	it('answers -1 inside a body, on the closing fence, between blocks and before the first', () => {
		expect(blockAt(blocks, blocks[0].from)).toBe(-1);
		expect(blockAt(blocks, blocks[1].from + 1)).toBe(-1);
		expect(blockAt(blocks, blocks[1].end)).toBe(-1);
		expect(blockAt(blocks, blocks[1].start - 3)).toBe(-1);
		expect(blockAt(mermaidBlocks('text\n\n' + note('a')), 1)).toBe(-1);
	});
	it('takes an unclosed last block to the end of the note', () => {
		const open = 'x\n```mermaid\nflowchart LR\nA-->B';
		expect(mermaidBlocks(open)[0].end).toBe(open.length);
	});
	it('does not hand a drawing inside another block to that block (security review 0.24.0, O78)', () => {
		// Markdown: a js block (lines 0-5), then the mermaid block drawn in the note (lines 6-9).
		// This scanner opens only at column 0: its one block runs from line 1 to line 11.
		const lines = [' ```js', '````mermaid', 'flowchart TD', '  A[zoom shows this]-->B', 'accDescr {', '```',
			' ```mermaid', 'flowchart TD', '  X[note shows this]-->Y', '```', '}', '````', '````'];
		const t = lines.join('\n');
		const b = mermaidBlocks(t);
		const drawn = lines.slice(0, 6).join('\n').length + 1;  // where Live Preview draws the second
		expect(b.length).toBe(1);
		expect(drawn > b[0].from && drawn < b[0].end).toBe(true);
		expect(blockAt(b, drawn)).toBe(-1);
	});
});

describe('mermaidBlocks on crafted lines (security review 0.24.0, O77)', () => {
	it('stays linear on a long backtick run with a line separator', () => {
		for (const sep of ['\u2028', '\u2029', '\r']) {
			const t = '```mermaid\nflowchart LR\nA-->B\n```\n' + '`'.repeat(1_000_000) + sep + 'x\n';
			const t0 = performance.now();
			const b = mermaidBlocks(t);
			expect(performance.now() - t0).toBeLessThan(timeLimit(50));
			expect(b.map(x => x.body)).toEqual(['flowchart LR\nA-->B']);
		}
	});
	it('reads the same blocks as before', () => {
		expect(mermaidBlocks('~~~mermaid  \nA\n~~~\n```mermaid x\nB\n```\n```mermaidx\nC\n```\n```js\n```mermaid\n```').map(b => b.body)).toEqual(['A', 'B']);
		expect(mermaidBlocks('```mermaid\u2028\nA\n```')).toEqual([]);
	});
});

describe('narrowed (an edit writes only the characters that differ)', () => {
	const apply = (text: string, c: { from: number; to: number; insert: string }) => text.slice(0, c.from) + c.insert + text.slice(c.to);
	it('keeps the same text and touches only what changed', () => {
		const note = 'before\n```mermaid\nwardley-beta\ncomponent Tea [0.63, 0.81]\ncomponent Kettle [0.43, 0.35]\n```\nafter';
		const src = 'wardley-beta\ncomponent Tea [0.63, 0.81]\ncomponent Kettle [0.43, 0.35]';
		const at = note.indexOf(src);
		for (const next of [src.replace('0.35', '0.45'), src.replace('Tea', 'Green Tea'), `${src}\nTea -> Kettle`, src.replace('\ncomponent Kettle [0.43, 0.35]', ''), '', src]) {
			const c = narrowed(src, at, at + src.length, next);
			expect(apply(note, c)).toBe(note.slice(0, at) + next + note.slice(at + src.length));
			expect(c.from).toBeGreaterThanOrEqual(at);
			expect(c.to).toBeLessThanOrEqual(at + src.length);
		}
		expect(narrowed(src, at, at + src.length, src.replace('0.35', '0.45'))).toEqual({ from: at + src.indexOf('0.35') + 2, to: at + src.indexOf('0.35') + 3, insert: '4' });
		expect(narrowed(src, at, at + src.length, src)).toEqual({ from: at + src.length, to: at + src.length, insert: '' });
	});
	it('stays linear on long repeated text', () => {
		const long = 'a'.repeat(64 * 1024);
		const t0 = performance.now();
		narrowed(long, 0, long.length, `${long}b`);
		expect(performance.now() - t0).toBeLessThan(timeLimit(50));
	});
});

describe('lineEdits (an edit writes each changed run of lines on its own)', () => {
	const apply = (text: string, cs: { from: number; to: number; insert: string }[]) => {
		let out = '';
		let at = 0;
		for (const c of cs) { out += text.slice(at, c.from) + c.insert; at = c.to; }
		return out + text.slice(at);
	};
	const src = 'wardley-beta\ncomponent Alpha [0.80, 0.30]\ncomponent Epsilon [0.15, 0.90]\nAlpha -> Beta';
	it('turns the old text into the new one, for edits of every shape', () => {
		for (const next of [
			src.replace('0.80, 0.30', '0.72, 0.30').replace('Alpha -> Beta', 'Beta -> Alpha'),
			`${src}\nAlpha -> Gamma`, src.replace('component Alpha [0.80, 0.30]\n', ''), 'x', '', src,
			src.replace('wardley-beta\n', ''), `title T\n${src}`, src.split('\n').reverse().join('\n'),
		]) {
			const changes = lineEdits(src, next);
			expect(apply(src, changes)).toBe(next);
			for (let i = 1; i < changes.length; i++) expect(changes[i].from).toBeGreaterThanOrEqual(changes[i - 1].to);
		}
	});
	it('leaves an untouched line between two changed ones out of every change', () => {
		const next = src.replace('0.80, 0.30', '0.72, 0.30').replace('Alpha -> Beta', 'Beta -> Alpha');
		const epsilon = src.indexOf('component Epsilon');
		const changes = lineEdits(src, next, 100);
		expect(changes.length).toBe(2);
		expect(changes.every(c => c.to <= 100 + epsilon || c.from >= 100 + epsilon + 'component Epsilon [0.15, 0.90]'.length)).toBe(true);
	});
	it('stays fast on a crafted block', () => {
		const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
		const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
		const t0 = performance.now();
		expect(apply(a, lineEdits(a, b))).toBe(b);
		expect(performance.now() - t0).toBeLessThan(timeLimit(300));
	});
});
