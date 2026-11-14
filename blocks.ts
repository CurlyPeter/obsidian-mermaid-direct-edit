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

/** A change of a document: the characters `from` to `to` replaced by `insert`. */
export interface Change {
	from: number;
	to: number;
	insert: string;
}

/** The change that replaces `from`..`to` (holding `old`) by `insert`, trimmed to the characters that differ. */
export function narrowed(old: string, from: number, to: number, insert: string): Change {
	let head = 0;
	while (head < old.length && head < insert.length && old[head] === insert[head]) head++;
	let tail = 0;
	while (tail < old.length - head && tail < insert.length - head && old[old.length - 1 - tail] === insert[insert.length - 1 - tail]) tail++;
	return { from: from + head, to: to - tail, insert: insert.slice(head, insert.length - tail) };
}

/** Lines `from` up to `to` of the old text replaced by `lines` (`from === to` inserts). */
interface Hunk {
	from: number;
	to: number;
	lines: string[];
}

/** Beyond this size of the comparison table the changed middle counts as one block: a crafted note must not stall. */
const MAX_CELLS = 4_000_000;

/** The line changes that turn `a` into `b`, in order: a longest common subsequence of the changed middle. */
function lineHunks(a: string[], b: string[]): Hunk[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
	const n = endA - start;
	const m = endB - start;
	if (n === 0 && m === 0) return [];
	if (n === 0 || m === 0 || n * m > MAX_CELLS) return [{ from: start, to: endA, lines: b.slice(start, endB) }];
	const width = m + 1;
	const common = new Uint16Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			common[i * width + j] = a[start + i] === b[start + j]
				? common[(i + 1) * width + j + 1] + 1
				: Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
		}
	}
	const hunks: Hunk[] = [];
	let open: Hunk | null = null;
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[start + i] === b[start + j]) {
			open = null;
			i++;
			j++;
			continue;
		}
		if (!open) hunks.push(open = { from: start + i, to: start + i, lines: [] });
		if (j < m && (i === n || common[i * width + j + 1] >= common[(i + 1) * width + j])) {
			open.lines.push(b[start + j++]);
		} else {
			i++;
			open.to = start + i;
		}
	}
	return hunks;
}

/**
 * The changes that turn `old` (at offset `at` of a document) into `next`: one per run of changed lines,
 * each trimmed to the characters that differ, in order and not overlapping (0.30.0). An edit hands over
 * the whole block. Written whole, or as one range from the first change to the last, undo later puts
 * that whole range back and takes along whatever else changed in it meanwhile (another plugin, a sync):
 * a gesture often changes lines far apart (a moved element and a link that turned with it). Written
 * this way, a cursor inside the block's source stays put too.
 */
export function lineEdits(old: string, next: string, at = 0): Change[] {
	const lines = old.split('\n');
	const offsets = [0];
	for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
	return lineHunks(lines, next.split('\n')).map(h => {
		let from = Math.min(offsets[h.from], old.length);
		const to = Math.min(offsets[h.to], old.length);
		let insert = h.lines.join('\n');
		if (h.to < lines.length) insert += h.lines.length ? '\n' : '';  // the range ends after its line break
		else if (h.from === lines.length) insert = `\n${insert}`;  // after the last line, which has none
		else if (!h.lines.length && from > 0) from--;  // the last lines go, and the break before them
		const c = narrowed(old.slice(from, to), from, to, insert);
		return { from: c.from + at, to: c.to + at, insert: c.insert };
	});
}
