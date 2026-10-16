import { describe, expect, it } from 'vitest';
import { timeLimit } from './test-timing';
import { MAX_LINE, fenceBreak, isClosingFence, mermaidBlocks } from './blocks';
import { scan } from './flowchart-scan';
import { deleteEdge, flowchartBlocker, nodeInfo, setNodeLabel, ungroup } from './flowchart-text';

/** Runs `f` and fails when it takes longer than `ms` (a crafted note must never freeze Obsidian). */
function fast(f: () => unknown, ms = 150) {
	const t = performance.now();
	try { f(); } catch { /* refusing is fine, hanging is not */ }
	expect(performance.now() - t).toBeLessThan(timeLimit(ms));
}

const lines = (line: string) => `flowchart LR\n${Array.from({ length: 64 }, () => line).join('\n')}`;
const fill = (head: string, c: string) => head + c.repeat(MAX_LINE - head.length - 1);

describe('flowchart parsers stay linear on crafted text', () => {
	it('an unclosed inline label over a run of blanks', () => {
		fast(() => scan(lines(fill('A -- x', ' '))));
		fast(() => scan(lines(fill('A == x', '\t'))));
		fast(() => scan(lines(fill('A -. x', ' '))));
	});

	it('valid inline labels full of blanks (the closing arrow is looked for once per blank run)', () => {
		const src = `flowchart LR\n${Array.from({ length: 64 }, (_v, i) => `A${i} -- x${' '.repeat(940)}y --> B${i}`).join('\n')}`;
		fast(() => scan(src), 20);
	});

	it('long runs where the lexer could backtrack', () => {
		fast(() => scan(lines(fill('A ', '-'))));
		fast(() => scan(lines(fill('A ', '='))));
		fast(() => scan(lines(fill('A -', '.'))));
		fast(() => scan(lines(fill('A ', '~'))));
		fast(() => scan(lines(fill('A', '@'))));
		fast(() => scan(lines(fill('A-->', 'B@'))));
		fast(() => scan(lines(fill('A[', '/'))));
		fast(() => scan(lines(fill('A["', 'x'))));
		fast(() => scan(lines(fill('A@{', '"'))));
		fast(() => scan(lines(fill('A-->|', 'x'))));
		fast(() => scan(lines(fill('subgraph ', '['))));
		fast(() => scan(lines(fill('style A ', ';'))));
	});

	it('an unclosed @{ or accDescr block over the whole source', () => {
		fast(() => scan(`flowchart LR\nA@{ ${'x\n'.repeat(30000)}`));
		fast(() => scan(`flowchart LR\naccDescr { ${'x\n'.repeat(30000)}`));
	});

	it('edits over a statement with many edges and a line full of blanks', () => {
		const chain = `flowchart LR\n${Array.from({ length: 300 }, (_v, i) => `N${i}`).join(' & ')} --> Z`;
		fast(() => deleteEdge(chain, 150), 500);
		fast(() => setNodeLabel(`flowchart LR\n${' '.repeat(900)}A --> B`, 'A', 'x'));
	});

	it('refuses sources that are too large or have a too long line, before scanning', () => {
		expect(flowchartBlocker(`flowchart LR\n${'A --> B\n'.repeat(9000)}`)).toMatch(/too large/);
		expect(flowchartBlocker(`flowchart LR\nA --> B${' '.repeat(MAX_LINE)}`)).toMatch(/too long/);
		expect(flowchartBlocker('flowchart LR\nA --> B')).toBeNull();
	});
});

describe('security review 0.18.0', () => {
	it('O69: ungroup keeps continuation lines as they are, so no fence reaches column 0', () => {
		for (const indent of ['    ', '\t']) {
			const src = `flowchart LR\nsubgraph G\n${indent}A --> B\n${indent}%%{init: {}\n${indent}\`\`\`\n${indent}\`\`\`dataviewjs\n${indent}dv.paragraph("injected")\n${indent}\`\`\`\n${indent}}%%\nend`;
			const next = ungroup(src, 'G');
			expect(next.split('\n').some(l => isClosingFence(l, '```'))).toBe(false);
			expect(next).toContain(`${indent}\`\`\`dataviewjs`);
		}
	});

	it('O69: every write refuses text that would close its code block', () => {
		const note = 'x\n```mermaid\nflowchart LR\n  A --> B\n```\ny';
		const at = note.indexOf('flowchart');
		expect(fenceBreak(note, at, 'flowchart LR\n  A --> C')).toBeNull();
		expect(fenceBreak(note, at, 'flowchart LR\n```\n  A --> C')).toMatch(/end the diagram/);
		expect(fenceBreak(note, at, 'flowchart LR\n   ````  \n  A --> C')).toMatch(/end the diagram/);
		expect(fenceBreak(note, at, 'flowchart LR\n    ```\n  A --> C')).toBeNull();  // four spaces: code, not a fence
		expect(fenceBreak(note, at, 'flowchart LR\n~~~\n  A --> C')).toBeNull();     // another kind of fence
		const tilde = 'x\n~~~mermaid\nflowchart LR\n~~~\ny';
		expect(fenceBreak(tilde, tilde.indexOf('flowchart'), 'flowchart LR\n```')).toBeNull();
		expect(fenceBreak(tilde, tilde.indexOf('flowchart'), 'flowchart LR\n  ~~~~')).toMatch(/end the diagram/);
	});

	it('O69: a closing fence indented up to three spaces ends a block, as in Markdown', () => {
		expect(mermaidBlocks('```mermaid\nflowchart LR\n   ```\nafter').map(b => b.body)).toEqual(['flowchart LR']);
	});

	it('O70: many unclosed directives cost one search', () => {
		const src = `flowchart LR\nA --> B\nB --> C\nC --> D\n%%{a\n${'%%{\n'.repeat(8150)}${'}\n'.repeat(32)}`;
		fast(() => scan(src), 50);
	});

	it('O70: & groups stop at Mermaid\'s 500 links before multiplying out', () => {
		const side = Array.from({ length: 124 }, (_v, i) => `N${i}`).join(' & ');
		const src = `flowchart LR\n${Array.from({ length: 64 }, () => `${side} --> ${side}`).join('\n')}`;
		fast(() => scan(src), 50);
		expect(() => scan(src)).toThrow(/500/);
	});

	it('O70: chains without blanks and dotted labels stay linear', () => {
		const chain = `flowchart LR\n${Array.from({ length: 64 }, (_v, l) => Array.from({ length: 120 }, (_w, i) => `L${l}N${i}`).join('-->')).join('\n')}`;
		fast(() => scan(chain), 60);
		const dots = `flowchart LR\n${Array.from({ length: 64 }, (_v, i) => `A${i} -. x${'.'.repeat(900)}y .-> B${i}`).join('\n')}`;
		fast(() => scan(dots), 40);
	});

	it('O70: a dialog reading every node scans the source once', () => {
		const src = `flowchart LR\n${Array.from({ length: 490 }, (_v, i) => `N${i} --> N${i + 1}`).join('\n')}`;
		fast(() => { for (let i = 0; i < 491; i++) nodeInfo(src, `N${i}`); }, 150);
	});
});
