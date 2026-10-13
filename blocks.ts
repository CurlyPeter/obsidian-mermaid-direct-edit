/**
 * Where a diagram's code block sits in a note, for every diagram type. Pure text, no DOM.
 */

/** An edit that cannot be made; its message is shown to the user. */
export class EditError extends Error {}

/**
 * Limits for graphical editing (security review on 0.12.0, F1/F2/F6). The parsers are linear,
 * and these bounds keep the few remaining per-line regexes cheap. A diagram beyond them still
 * renders, it is just not editable.
 */
export const MAX_LINE = 1000;
export const MAX_SOURCE = 64 * 1024;

/** `s` without trailing blanks. A loop, because `/[ \t]+$/` is quadratic on a long blank run. */
export const trimTail = (s: string) => {
	let e = s.length;
	while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
	return s.slice(0, e);
};

/**
 * Where `src` sits in `text`: the offset of the body of the one fenced ```mermaid block whose
 * body is exactly `src`, or why it cannot be edited there. Only a block of its own counts: a
 * diagram in a callout, list or quote is drawn from text with a prefix on every line, and a plain
 * search would find (and overwrite) the same text elsewhere, e.g. in a code example (review F3).
 */
export function locateBlock(text: string, src: string): number | string {
	const hits = mermaidBlocks(text).filter(b => b.body === src).map(b => b.from);
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) return 'This diagram occurs more than once in the note, edit it in the source.';
	if (text.includes(src)) return 'Only a diagram in a ```mermaid block of its own can be edited here (not in a callout, list or quote), edit it in the source.';
	return 'The diagram changed in the meantime, nothing was written.';
}

/** A fenced mermaid block: where its opening fence line starts, where its body starts, the body, where the block ends. */
export interface MermaidBlock {
	start: number;
	from: number;
	body: string;
	end: number;
}

/**
 * Every fenced ```mermaid (or ~~~mermaid) block of its own in a note: the offset of its body
 * and the body, plus the block's whole extent (fences included). Fences inside other code blocks
 * are skipped; a block in a callout, list or quote has a prefix on its fence line and is not one
 * of them.
 */
export function mermaidBlocks(text: string): MermaidBlock[] {
	const lines = text.split('\n');
	const starts: number[] = [];
	let offset = 0;
	for (const l of lines) { starts.push(offset); offset += l.length + 1; }
	const out: MermaidBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		// The fence prefix only, then the rest of the line on its own: `(.*)$` backtracked over the
		// whole backtick run on a line holding \r, U+2028 or U+2029 (which `.` does not match),
		// quadratic in its length (security review 0.24.0, O77). Such a line opens nothing, as before.
		const open = /^(`{3,}|~{3,})/.exec(lines[i]);
		if (!open || /[\r\u2028\u2029]/.test(lines[i])) continue;
		const fence = open[1];
		let close = i + 1;
		while (close < lines.length && !isClosingFence(lines[close], fence)) close++;
		if (/^mermaid(?:[ \t]|$)/.test(lines[i].slice(fence.length).trim()) && i + 1 <= lines.length - 1) {
			const from = starts[i + 1];
			const body = close < lines.length ? text.slice(from, Math.max(from, starts[close] - 1)) : text.slice(from);
			const end = close < lines.length ? starts[close] + lines[close].length : text.length;
			out.push({ start: starts[i], from, body, end });
		}
		i = close;
	}
	return out;
}

/**
 * The index of the block whose opening fence line holds `offset` (where Live Preview puts the
 * drawing of a block), or -1. Only the opening line: where this scanner and Markdown read fences
 * differently, an offset deeper inside a block would name another block than the one drawn, and
 * an edit there would land in text Markdown reads as something else (security review 0.24.0, O78).
 */
export function blockAt(blocks: MermaidBlock[], offset: number): number {
	return blocks.findIndex(b => offset >= b.start && offset < b.from);
}

/**
 * Which of a note's mermaid blocks a zoomed diagram shows after the note changed (`bodies`, in
 * order). It showed block `index` of `count` with the text `body`. While the number of blocks is
 * the same, it is still block `index` (that block, or another, was edited). Otherwise a block was
 * added or removed elsewhere: the block still holding `body`, the one nearest `index` when several
 * do. Null when none does: the diagram is gone, or it changed at the same time as the count.
 */
export function followBlock(bodies: string[], count: number, index: number, body: string): number | null {
	if (bodies.length === count && index >= 0 && index < count) return index;
	let best: number | null = null;
	for (let i = 0; i < bodies.length; i++) {
		if (bodies[i] === body && (best === null || Math.abs(i - index) < Math.abs(best - index))) best = i;
	}
	return best;
}

/**
 * Whether Markdown reads `line` as the fence that closes a block opened with `fence`: up to three
 * spaces, at least as many of the same fence characters, nothing else (a tab counts as four
 * spaces, so it never qualifies).
 */
export const isClosingFence = (line: string, fence: string) => {
	let i = 0;
	while (i < 3 && line[i] === ' ') i++;
	const t = trimTail(line.slice(i));
	return t.length >= fence.length && t[0] === fence[0] && [...t].every(c => c === fence[0]);
};

/**
 * Why `next`, written as the body of the block whose body starts at `at` in `text`, would end that
 * block early (a line Markdown reads as its closing fence), or null. Everything after such a line
 * would become live Markdown in the note (security review O69); every write and every undo goes
 * through this check.
 */
export function fenceBreak(text: string, at: number, next: string): string | null {
	const open = /^(`{3,}|~{3,})/.exec(text.slice(text.lastIndexOf('\n', at - 2) + 1, at));
	if (!open) return 'The diagram is not in a fenced code block of its own, nothing was written.';
	if (next.split('\n').some(l => isClosingFence(l, open[1]))) return 'The edit would end the diagram\'s code block early, nothing was written.';
	return null;
}
