/**
 * Pure text edits on a `wardley-beta` source (Mermaid 12.1 grammar). No DOM, no Obsidian:
 * every function takes the block's source and returns the new source or throws an
 * `EditError` whose message is shown to the user. The caller validates the result with
 * `mermaid.parse()` before writing it, so a gap in these rules cannot corrupt a note.
 */

import { EditError, MAX_LINE, MAX_SOURCE, trimTail } from './blocks';

export { EditError, MAX_LINE, MAX_SOURCE };

/**
 * Mermaid's NAME_WITH_SPACES terminal: a name that needs no quotes. The lexer matches its
 * lowercase keywords as prefixes, so a bare name that merely starts with one (`builder`,
 * `notes`, `title`) fails to parse and has to be quoted (measured against 12.1).
 */
const KEYWORD_PREFIX = /^(?:wardley-beta|size|evolution|evolve|anchor|component|label|inertia|pipeline|note|annotations?|accelerator|deaccelerator|build|buy|outsource|market|title|accTitle|accDescr)/;
const BARE_NAME = /^[A-Za-z](?:[A-Za-z0-9_()&]|-(?!>))*(?:[ \t]+[A-Za-z(](?:[A-Za-z0-9_()&]|-(?!>))*)*$/;

/**
 * Link and flow arrows, longest first so `-.->` is not read as `->` (sticky: tried at one index).
 * Mermaid 12.1's LINK_ARROW also has inline-label flows `+'x'<` and `+'x'<>` (0.15.0).
 */
const ARROW = /-\.->|-->|->|\+<>|\+<|\+>|\+'[^']*'(?:<>|<|>)|\+"[^"]*">/y;

const isBlank = (c: string) => c === ' ' || c === '\t';

export interface NameSpan {
	/** Offsets into the line, covering the quotes when the name is quoted. */
	start: number;
	end: number;
	/** The name without quotes. */
	name: string;
	/** Declares the element (`anchor`/`component`), as opposed to referencing it. */
	declaration: boolean;
	/** For a declaration: which kind. */
	kind?: 'anchor' | 'component';
}

/** How a name has to be written in the source. Throws when it cannot be written at all. */
export function formatName(name: string): string {
	const n = name.trim();
	if (!n) throw new EditError('The name must not be empty.');
	if (/[\r\n]/.test(n)) throw new EditError('The name must be a single line.');
	if (BARE_NAME.test(n) && !KEYWORD_PREFIX.test(n)) return n;
	if (!n.includes('"')) return `"${n}"`;
	if (!n.includes("'")) return `'${n}'`;
	throw new EditError('A name cannot contain both kinds of quotes.');
}

/** Where a bare name in `rest` ends: before the first `ch`, or at the end. */
const upTo = (ch: string) => (rest: string) => { const i = rest.indexOf(ch); return i < 0 ? rest.length : i; };
/** `evolve <name> <target>`: the name ends before its last token when that token is a number. */
const beforeTarget = (rest: string) => {
	const t = trimTail(rest);
	let ws = t.length - 1;
	while (ws >= 0 && !isBlank(t[ws])) ws--;
	return ws >= 0 && /^[-\d.]+$/.test(t.slice(ws + 1)) ? ws : rest.length;
};

/** Reads one name token starting at `pos` (after whitespace); `stop` says where a bare name ends. */
function readName(line: string, pos: number, stop: (rest: string) => number): NameSpan | null {
	while (pos < line.length && isBlank(line[pos])) pos++;
	if (pos >= line.length) return null;
	const q = line[pos];
	if (q === '"' || q === "'") {
		const close = line.indexOf(q, pos + 1);
		if (close < 0) return null;
		return { start: pos, end: close + 1, name: line.slice(pos + 1, close), declaration: false };
	}
	const rest = line.slice(pos);
	const trimmed = trimTail(rest.slice(0, stop(rest)));
	if (!trimmed) return null;
	return { start: pos, end: pos + trimmed.length, name: trimmed, declaration: false };
}

/** Index of the first arrow outside quotes, or -1. */
function findArrow(line: string): { index: number; length: number } {
	let quote = '';
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) { if (c === quote) quote = ''; continue; }
		if (c === '"') { quote = c; continue; }
		// a single quote opens a quoted name only at a token start, `+'label'>` is an arrow
		if (c === "'" && (i === 0 || /[\s>]/.test(line[i - 1]))) { quote = c; continue; }
		ARROW.lastIndex = i;
		const m = ARROW.exec(line);
		if (m) return { index: i, length: m[0].length };
	}
	return { index: -1, length: 0 };
}

/** Every element name on one source line, with its position. */
export function nameSpans(line: string): NameSpan[] {
	const kw = /^([ \t]*)(anchor|component|evolve|pipeline)[ \t]+/.exec(line);
	if (kw) {
		const at = kw[0].length;
		if (kw[2] === 'evolve') {
			const s = readName(line, at, beforeTarget);
			return s ? [s] : [];
		}
		if (kw[2] === 'pipeline') {
			const s = readName(line, at, upTo('{'));
			return s ? [s] : [];
		}
		const s = readName(line, at, upTo('['));
		return s ? [{ ...s, declaration: true, kind: kw[2] as 'anchor' | 'component' }] : [];
	}
	if (/^[ \t]*(%%|title\b|size\b|note\b|annotations?\b|evolution\b|accTitle|accDescr|wardley-beta|\})/.test(line)) return [];
	const arrow = findArrow(line);
	if (arrow.index < 0) return [];
	const left = readName(line.slice(0, arrow.index), 0, rest => rest.length);
	const right = readName(line, arrow.index + arrow.length, upTo(';'));
	return [left, right].filter((s): s is NameSpan => s !== null);
}

/** Line index and span of the single declaration of `name`. */
function findDeclaration(lines: string[], name: string): { line: number; span: NameSpan } {
	const hits: { line: number; span: NameSpan }[] = [];
	lines.forEach((l, i) => {
		for (const span of nameSpans(l)) if (span.declaration && span.name === name) hits.push({ line: i, span });
	});
	if (hits.length === 0) throw new EditError(`"${name}" is not declared in this map.`);
	if (hits.length > 1) throw new EditError(`"${name}" is declared ${hits.length} times, edit it in the source.`);
	return hits[0];
}

/**
 * The position right after a declared name: `[v, e]` or a pipeline child's `[e]`, as the
 * parts `[whole, head, v, gap, sep, e, gap]` (one value: only the first four). Hand-written,
 * because the equivalent regex backtracked cubically on a crafted line (review F2).
 */
function position(s: string): string[] | null {
	let i = 0;
	while (i < s.length && isBlank(s[i])) i++;
	if (s[i] !== '[') return null;
	i++;
	while (i < s.length && isBlank(s[i])) i++;
	const head = s.slice(0, i);
	let j = i;
	while (j < s.length && s[j] !== ']' && s[j] !== ',') j++;
	if (j >= s.length) return null;
	const v = trimTail(s.slice(i, j));
	if (!v) return null;
	const gap = s.slice(i + v.length, j);
	if (s[j] === ']') return [s.slice(0, j + 1), head, v, gap];
	let k = j + 1;
	while (k < s.length && isBlank(s[k])) k++;
	const close = s.indexOf(']', k);
	if (close < 0) return null;
	const e = trimTail(s.slice(k, close));
	if (!e) return null;
	return [s.slice(0, close + 1), head, v, gap, s.slice(j + 1, k), e, s.slice(k + e.length, close)];
}

/** Declared position of an element; a pipeline child has only its evolution. */
export function getPosition(source: string, name: string): { visibility?: number; evolution: number } {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	const m = position(lines[line].slice(span.end));
	if (!m) throw new EditError(`"${name}" has no position.`);
	return m[5] === undefined
		? { evolution: Number(m[2]) }
		: { visibility: Number(m[2]), evolution: Number(m[5]) };
}

const fmt = (v: number) => (Math.round(Math.min(1, Math.max(0, v)) * 100) / 100).toFixed(2);

/**
 * Moves an anchor or component. A pipeline child carries only its evolution
 * (`component X [0.6]`) and keeps that single value.
 */
export function setPosition(source: string, name: string, visibility: number, evolution: number): string {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	const text = lines[line];
	const after = text.slice(span.end);
	const m = position(after);
	if (!m) throw new EditError(`"${name}" has no position to change.`);
	const coords = m[5] === undefined
		? `${m[1]}${fmt(evolution)}${m[3]}]`
		: `${m[1]}${fmt(visibility)}${m[3]},${m[4]}${fmt(evolution)}${m[6]}]`;
	lines[line] = text.slice(0, span.end) + coords + after.slice(m[0].length);
	return lines.join('\n');
}

/**
 * Sets a component's label offset, `label [dx, dy]` in map pixels relative to the
 * component's centre (Mermaid 12.1: integers only, placed right after the position and
 * before any decorator). Anchors have no label offset in the grammar.
 */
export function setLabelOffset(source: string, name: string, dx: number, dy: number): string {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	if (span.kind === 'anchor') throw new EditError('An anchor label cannot be moved in wardley-beta, move the anchor instead.');
	const text = lines[line];
	const after = text.slice(span.end);
	const pos = position(after);
	if (!pos) throw new EditError(`"${name}" has no position.`);
	const rest = after.slice(pos[0].length);
	const label = `label [${Math.round(dx)}, ${Math.round(dy)}]`;
	const existing = /^([ \t]+)label[ \t]*\[[^\]]*\]/.exec(rest);
	const tail = existing ? `${existing[1]}${label}${rest.slice(existing[0].length)}` : ` ${label}${rest}`;
	lines[line] = text.slice(0, span.end) + pos[0] + tail;
	return lines.join('\n');
}

/** Sets the target of `evolve <name> <evolution>`, the red dashed arrow. */
export function setEvolveTarget(source: string, name: string, evolution: number): string {
	const lines = source.split('\n');
	const hits = lines
		.map((l, i) => ({ i, span: /^[ \t]*evolve[ \t]/.test(l) ? nameSpans(l)[0] : undefined }))
		.filter(h => h.span?.name === name);
	if (hits.length === 0) throw new EditError(`"${name}" has no evolve arrow.`);
	if (hits.length > 1) throw new EditError(`"${name}" has ${hits.length} evolve lines, edit it in the source.`);
	const { i, span } = hits[0];
	const text = lines[i];
	const m = /^([ \t]+)[-\d.]+/.exec(text.slice(span!.end));
	if (!m) throw new EditError(`The evolve line of "${name}" has no target.`);
	lines[i] = text.slice(0, span!.end) + m[1] + fmt(evolution) + text.slice(span!.end + m[0].length);
	return lines.join('\n');
}

/**
 * Moves one end of the link between `a` and `b` (any arrow, either written order) from
 * `oldEnd` to `newName`; a class set on the link stays with it. Refuses a self-link and a link
 * that already exists.
 */
/** The two name spans of a link line, or null for any other line. */
function linkPair(line: string): NameSpan[] | null {
	if (/^[ \t]*(anchor|component|evolve|pipeline)[ \t]/.test(line) || findArrow(line).index < 0) return null;
	const sp = nameSpans(line);
	return sp.length === 2 ? sp : null;
}

const samePair = (sp: NameSpan[], x: string, y: string) =>
	(sp[0].name === x && sp[1].name === y) || (sp[0].name === y && sp[1].name === x);

/** Line index of the single link between `a` and `b`, in either written order. */
function findLink(lines: string[], a: string, b: string): { i: number; sp: NameSpan[] } {
	const hits = lines.map((l, i) => ({ i, sp: linkPair(l) })).filter(h => h.sp && samePair(h.sp, a, b));
	if (hits.length === 0) throw new EditError(`No link between "${a}" and "${b}".`);
	if (hits.length > 1) throw new EditError(`"${a}" and "${b}" are linked ${hits.length} times, edit it in the source.`);
	return { i: hits[0].i, sp: hits[0].sp! };
}

const linked = (lines: string[], x: string, y: string) => lines.some(l => { const sp = linkPair(l); return sp !== null && samePair(sp, x, y); });

export function relink(source: string, a: string, b: string, oldEnd: string, newName: string): string {
	const lines = source.split('\n');
	const { i, sp } = findLink(lines, a, b);
	findDeclaration(lines, newName);
	const other = oldEnd === a ? b : a;
	if (newName === other) throw new EditError(`"${other}" cannot be linked to itself.`);
	if (linked(lines, other, newName)) throw new EditError(`"${other}" and "${newName}" are already linked.`);
	const span = sp.find(x => x.name === oldEnd);
	if (!span) throw new EditError(`"${oldEnd}" is not an end of this link.`);
	lines[i] = lines[i].slice(0, span.start) + formatName(newName) + lines[i].slice(span.end);
	// A class on the link stays with it.
	return editClassTargets(lines, t => (typeof t !== 'string' && sameTarget(t, [a, b]) ? t.map(n => (n === oldEnd ? newName : n)) : undefined)).join('\n');
}

/** Index of the single `evolve <name> …` line, or -1 (throws when there are several). */
function findEvolve(lines: string[], name: string): number {
	const hits = lines.map((l, i) => (/^[ \t]*evolve[ \t]/.test(l) && nameSpans(l)[0]?.name === name ? i : -1)).filter(i => i >= 0);
	if (hits.length > 1) throw new EditError(`"${name}" has ${hits.length} evolve lines, edit it in the source.`);
	return hits.length ? hits[0] : -1;
}

/** Inserts `text` after the last line matching the first predicate that matches any. */
function insertAfterLast(lines: string[], text: string, ...preds: ((l: string, i: number) => boolean)[]): void {
	for (const pred of preds) {
		let at = -1;
		lines.forEach((l, i) => { if (pred(l, i)) at = i; });
		if (at >= 0) {
			const indent = /^[ \t]*/.exec(lines[at])?.[0] ?? '';
			lines.splice(at + 1, 0, indent + text);
			return;
		}
	}
	lines.push(text);
}

/** Braces outside quoted names change the nesting depth (`component "a{b"` does not). */
const braceDelta = (l: string) => {
	const bare = l.replace(/"[^"]*"|'[^']*'/g, '');
	return (bare.match(/\{/g) ?? []).length - (bare.match(/\}/g) ?? []).length;
};

/** Top-level declarations only (by line index): a pipeline's children sit between `{` and `}`. */
function topLevelDeclaration(lines: string[]): (l: string, i: number) => boolean {
	const top = new Set<number>();
	let depth = 0;
	lines.forEach((l, i) => {
		if (depth === 0 && nameSpans(l).some(s => s.declaration)) top.add(i);
		depth += braceDelta(l);
	});
	return (_l, i) => top.has(i);
}

/** Deletes the evolve arrow of `name`. */
export function deleteEvolve(source: string, name: string): string {
	const lines = source.split('\n');
	const i = findEvolve(lines, name);
	if (i < 0) throw new EditError(`"${name}" has no evolve arrow.`);
	lines.splice(i, 1);
	return lines.join('\n');
}

/** Adds `evolve <name> <target>` for a component that has none yet. */
export function addEvolve(source: string, name: string, target: number): string {
	const lines = source.split('\n');
	const { span } = findDeclaration(lines, name);
	if (span.kind === 'anchor') throw new EditError('Anchors do not evolve, pick a component.');
	if (findEvolve(lines, name) >= 0) throw new EditError(`"${name}" already has an evolve arrow.`);
	insertAfterLast(lines, `evolve ${formatName(name)} ${fmt(target)}`,
		l => /^[ \t]*evolve[ \t]/.test(l), l => linkPair(l) !== null, topLevelDeclaration(lines));
	return lines.join('\n');
}

const INERTIA = /[ \t]+\(inertia\)|[ \t]+inertia\b/;

/**
 * Plugin extension, not part of wardley-beta: `%% mp-inertia <name> <evolution>` places a
 * component's inertia bar on its evolution axis. The standard only knows inertia as a flag
 * (Mermaid draws the bar at a fixed offset); other renderers ignore the comment.
 */
const INERTIA_HEAD = /^[ \t]*%%[ \t]*mp-inertia[ \t]+/;
/** The parts `[whole, head, name, gap, evolution]` of an `mp-inertia` line, read in linear time (review F1). */
function inertiaComment(l: string): string[] | null {
	if (l.length > MAX_LINE) return null;
	const head = INERTIA_HEAD.exec(l)?.[0];
	if (!head) return null;
	const t = trimTail(l.slice(head.length));
	let ws = t.length - 1;
	while (ws >= 0 && !isBlank(t[ws])) ws--;
	const evo = t.slice(ws + 1);
	const name = trimTail(t.slice(0, Math.max(0, ws)));
	if (ws < 0 || !name || !/^[-\d.]+$/.test(evo)) return null;
	return [l, head, name, t.slice(name.length, ws + 1), evo];
}
const unquote = (n: string) => (/^(["']).*\1$/.test(n) ? n.slice(1, -1) : n);

/** Inertia bar positions set by the plugin extension, by component name. */
export function inertiaPositions(source: string): Map<string, number> {
	return new Map(inertiaMarkers(source).map(m => [m.name, m.evolution]));
}

/** Every `%% mp-inertia` comment with its 1-based line. */
export function inertiaMarkers(source: string): { name: string; evolution: number; line: number }[] {
	const out: { name: string; evolution: number; line: number }[] = [];
	source.split('\n').forEach((l, i) => {
		const m = inertiaComment(l);
		if (m) out.push({ name: unquote(m[2].trim()), evolution: Number(m[4]), line: i + 1 });
	});
	return out;
}

/** Sets where a component's inertia bar sits (written right after its declaration). */
export function setInertiaPosition(source: string, name: string, evolution: number): string {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	if (!INERTIA.test(lines[line].slice(span.end))) throw new EditError(`"${name}" has no inertia.`);
	const text = `%% mp-inertia ${formatName(name)} ${fmt(evolution)}`;
	const existing = lines.findIndex(l => { const m = inertiaComment(l); return m !== null && unquote(m[2].trim()) === name; });
	if (existing >= 0) lines[existing] = (/^[ \t]*/.exec(lines[existing])?.[0] ?? '') + text;
	else lines.splice(line + 1, 0, (/^[ \t]*/.exec(lines[line])?.[0] ?? '') + text);
	return lines.join('\n');
}

/** Drops the extension comment of `name`, if any. */
function withoutInertiaPosition(lines: string[], name: string): string[] {
	return lines.filter(l => { const m = inertiaComment(l); return !(m && unquote(m[2].trim()) === name); });
}

/** Whether a component carries the inertia decorator. */
export function hasInertia(source: string, name: string): boolean {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	return INERTIA.test(lines[line].slice(span.end));
}

/** Adds or removes `(inertia)`; it must come last, after a build/buy/outsource decorator. */
export function setInertia(source: string, name: string, on: boolean): string {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	if (span.kind === 'anchor') throw new EditError('Anchors cannot have inertia, pick a component.');
	const head = lines[line].slice(0, span.end);
	const rest = lines[line].slice(span.end);
	const has = INERTIA.test(rest);
	if (has === on) throw new EditError(on ? `"${name}" already has inertia.` : `"${name}" has no inertia.`);
	lines[line] = on ? head + trimTail(rest) + ' (inertia)' : head + rest.replace(INERTIA, '');
	return (on ? lines : withoutInertiaPosition(lines, name)).join('\n');
}

// ---- classes: `%% class <targets> <class>` and `%% classDef <class> <styles>` ---------------

/**
 * Mermaid's own `class` statement, commented out until wardley-beta has it (DEV.md → "Classes
 * for wardley-beta"): `%% class Kettle highlight`, `%% class Kettle -> Power highlight`, several
 * targets comma-separated. Deleting `%% ` is meant to be the whole migration, so there is no
 * `mp-` prefix. A link target names the unordered pair of its ends; its arrow is always `->`,
 * whatever the link draws.
 */
const CLASS_HEAD = /^[ \t]*%%[ \t]*class[ \t]+/;
const CLASS_DEF_HEAD = /^[ \t]*%%[ \t]*classDef[ \t]+/;
/**
 * A class name, as Mermaid's flowcharts accept it, at most 40 characters: names are written into
 * the drawing, and a long one repeated on many elements blew up its size (security review 0.19.0).
 */
export const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/;
/** Classes per element or link the drawing applies, and `wardley-apply` sets. */
export const MAX_CLASSES = 8;

/** What a class is set on: an element's name, or the two names of a link (either order). */
export type ClassTarget = string | [string, string];

interface NameTok { start: number; end: number; name: string }
/** One target of a class line, with its offsets in the line; `names` is short when malformed. */
interface TargetSpan { start: number; end: number; link: boolean; names: NameTok[] }

/** A name between `from` and `to`, blanks trimmed: quoted (quotes dropped) or bare. */
function nameToken(l: string, from: number, to: number): NameTok | null {
	while (from < to && isBlank(l[from])) from++;
	while (to > from && isBlank(l[to - 1])) to--;
	if (from >= to) return null;
	const q = l[from];
	if ((q === '"' || q === "'") && to - from >= 2 && l[to - 1] === q) return { start: from, end: to, name: l.slice(from + 1, to - 1) };
	return { start: from, end: to, name: l.slice(from, to) };
}

/**
 * A `%% class` line: its targets and its class (the last token). Null for any other line.
 * One pass over the line; a quote is skipped to its closing quote in one step (linear, like
 * every parser on note text, review F1).
 */
function classLine(l: string): { targets: TargetSpan[]; cls: string; head: string } | null {
	if (l.length > MAX_LINE) return null;
	const head = CLASS_HEAD.exec(l)?.[0];
	if (!head) return null;
	const end = trimTail(l).length;
	let ws = end - 1;
	while (ws >= head.length && !isBlank(l[ws])) ws--;
	const cls = l.slice(ws + 1, end);
	return { targets: ws < head.length ? [] : scanTargets(l, head.length, ws), cls, head };
}

/**
 * The comma-separated targets of `l` between `from` and `to`: element names (quoted or bare) and
 * links `A -> B`. One pass; a quote opens only at a token start and is skipped to its closing
 * quote in one step.
 */
function scanTargets(l: string, from: number, to: number): TargetSpan[] {
	const targets: TargetSpan[] = [];
	let segStart = from, arrow = -1;
	const close = (segEnd: number) => {
		if (arrow < 0) {
			const n = nameToken(l, segStart, segEnd);
			targets.push(n ? { start: n.start, end: n.end, link: false, names: [n] } : { start: segStart, end: segEnd, link: false, names: [] });
			return;
		}
		const a = nameToken(l, segStart, arrow), b = nameToken(l, arrow + 2, segEnd);
		targets.push({ start: a?.start ?? arrow, end: b?.end ?? arrow + 2, link: true, names: a && b ? [a, b] : [] });
	};
	for (let i = from; i < to; i++) {
		const c = l[i];
		if ((c === '"' || c === "'") && (i === segStart || isBlank(l[i - 1]) || l[i - 1] === ',' || l[i - 1] === '>')) {
			const q = l.indexOf(c, i + 1);
			if (q < 0 || q >= to) break;
			i = q;
		} else if (c === '-' && l[i + 1] === '>' && arrow < 0) {
			arrow = i++;
		} else if (c === ',') {
			close(i);
			segStart = i + 1;
			arrow = -1;
		}
	}
	close(to);
	return targets;
}

const targetOf = (t: TargetSpan): ClassTarget | null =>
	t.link ? (t.names.length === 2 ? [t.names[0].name, t.names[1].name] : null) : (t.names.length === 1 ? t.names[0].name : null);

/** Whether two targets are the same element, or the same link in either order. */
export function sameTarget(a: ClassTarget, b: ClassTarget): boolean {
	if (typeof a === 'string' || typeof b === 'string') return a === b;
	return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

/** Whether a target names `name`: the element itself or a link with that end. */
const touches = (t: ClassTarget, name: string) => (typeof t === 'string' ? t === name : t.includes(name));

/** Every `%% class` line with its 1-based line; `problem` says why a line sets nothing. */
export function classMarkers(source: string): { line: number; cls: string; targets: ClassTarget[]; problem?: string }[] {
	const out: { line: number; cls: string; targets: ClassTarget[]; problem?: string }[] = [];
	source.split('\n').forEach((l, i) => {
		const c = classLine(l);
		if (!c) return;
		const targets = c.targets.map(targetOf);
		const problem = !c.targets.length ? 'no target, write %% class <name> <class> or %% class <name> -> <name> <class>.'
			: !CLASS_NAME.test(c.cls) ? `"${c.cls}" is not a class name (letters, digits, _ and -, at most 40).`
				: targets.some(t => t === null) ? 'an empty name in its targets.' : undefined;
		out.push({ line: i + 1, cls: c.cls, targets: targets.filter((t): t is ClassTarget => t !== null), ...(problem ? { problem } : {}) });
	});
	return out;
}

/** The classes set on a target, in source order, each once. */
export function getClasses(source: string, target: ClassTarget): string[] {
	const out: string[] = [];
	for (const m of classMarkers(source)) {
		if (!m.problem && !out.includes(m.cls) && m.targets.some(t => sameTarget(t, target))) out.push(m.cls);
	}
	return out;
}

/**
 * Rewrites the targets of every `%% class` line. `f` answers per target: undefined keeps it,
 * null drops it, an array gives the names to write in place of its names. Names are replaced in
 * place, so the rest of the line keeps its spelling; a line that lost a target is written anew,
 * and one left without targets is removed.
 */
function editClassTargets(lines: string[], f: (t: ClassTarget, cls: string) => string[] | null | undefined): string[] {
	const out: string[] = [];
	for (const l of lines) {
		const c = classLine(l);
		if (!c || !c.targets.length) { out.push(l); continue; }
		const parts = c.targets.map(t => {
			const target = targetOf(t);
			return { t, r: target === null ? undefined : f(target, c.cls) };
		});
		if (parts.every(p => p.r === undefined)) { out.push(l); continue; }
		const write = (p: { t: TargetSpan; r: string[] | null | undefined }, text: string, base: number) => {
			if (!p.r) return text;
			for (let k = p.t.names.length - 1; k >= 0; k--) {
				const n = p.t.names[k];
				if (p.r[k] !== undefined && p.r[k] !== n.name) text = text.slice(0, n.start - base) + formatName(p.r[k]) + text.slice(n.end - base);
			}
			return text;
		};
		if (parts.some(p => p.r === null)) {
			const kept = parts.filter(p => p.r !== null).map(p => write(p, l.slice(p.t.start, p.t.end), p.t.start));
			if (kept.length) out.push(`${c.head}${kept.join(', ')} ${c.cls}`);
			continue;
		}
		let text = l;
		for (let k = parts.length - 1; k >= 0; k--) {
			const p = parts[k];
			text = text.slice(0, p.t.start) + write(p, l.slice(p.t.start, p.t.end), p.t.start) + text.slice(p.t.end);
		}
		out.push(text);
	}
	return out;
}

/**
 * Sets or removes a class on an element, a link or a group. A new `%% class` line goes after the last
 * one, else at the end of the map; removing takes the target out of every line that names it
 * with that class. The target must exist (no orphan lines).
 */
export function setClass(source: string, target: ClassTarget, cls: string, on: boolean): string {
	if (!CLASS_NAME.test(cls)) throw new EditError(`"${cls}" is not a class name (letters, digits, _ and -, at most 40).`);
	const lines = source.split('\n');
	// A group is set by its name, like an element; an element of the same name wins.
	if (typeof target === 'string') { if (!isGroup(source, target)) findDeclaration(lines, target); } else findLink(lines, target[0], target[1]);
	if (getClasses(source, target).includes(cls) === on) return source;
	if (!on) return editClassTargets(lines, (t, c) => (c === cls && sameTarget(t, target) ? null : undefined)).join('\n');
	const written = typeof target === 'string' ? formatName(target) : `${formatName(target[0])} -> ${formatName(target[1])}`;
	let at = -1;
	lines.forEach((l, i) => { if (classLine(l)) at = i; });
	if (at >= 0) {
		lines.splice(at + 1, 0, `${/^[ \t]*/.exec(lines[at])?.[0] ?? ''}%% class ${written} ${cls}`);
	} else {
		let end = lines.length;
		while (end > 0 && lines[end - 1].trim() === '') end--;
		lines.splice(end, 0, `%% class ${written} ${cls}`);
	}
	return lines.join('\n');
}

/** Makes `classes` exactly the classes of a target (`wardley-apply`). */
export function setClasses(source: string, target: ClassTarget, classes: string[]): string {
	const cur = getClasses(source, target);
	let s = source;
	for (const c of cur) if (!classes.includes(c)) s = setClass(s, target, c, false);
	for (const c of classes) if (!cur.includes(c)) s = setClass(s, target, c, true);
	return s;
}

/**
 * What a `%% classDef` may set, and the values it accepts: colours and plain numbers only. The
 * style is written into the drawing, and Mermaid itself had CSS injection through `classDef`,
 * so nothing else passes (no `url()`, no functions, no other properties).
 */
const COLOR = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{1,30})$/;
const STYLE_VALUE = new Map<string, RegExp>([
	['stroke', COLOR], ['fill', COLOR], ['color', COLOR],
	['stroke-width', /^\d{1,2}(?:\.\d{1,2})?(?:px)?$/],
	['stroke-dasharray', /^\d{1,3}(?: {1,3}\d{1,3}){0,7}$/],
	['font-weight', /^(?:normal|bold|[1-9]00)$/],
	// A group's radius, 8 to 120 drawing units: CSS's `r` (a circle's radius), here the radius of
	// the circle swept along the members. Elements ignore it. The cost is bounded by the group
	// budget, not by this cap (DEV.md 0.26.0); 120 is a fifth of the default map's height.
	['r', /^(?:(?:[89]|[1-9]\d|1[01]\d)(?:\.\d{1,2})?|120)(?:px)?$/],
]);
export const STYLE_PROPERTIES = [...STYLE_VALUE.keys()];

export interface ClassDef {
	line: number;
	name: string;
	/** The accepted properties. */
	style: Record<string, string>;
	/** Parts not accepted, as written. */
	rejected: string[];
}

/** Every `%% classDef <class> prop:value,prop:value` line (Mermaid's flowchart syntax). */
export function classDefs(source: string): ClassDef[] {
	const out: ClassDef[] = [];
	source.split('\n').forEach((l, i) => {
		if (l.length > MAX_LINE) return;
		const head = CLASS_DEF_HEAD.exec(l)?.[0];
		if (!head) return;
		const rest = trimTail(l.slice(head.length));
		let sp = 0;
		while (sp < rest.length && !isBlank(rest[sp])) sp++;
		const def: ClassDef = { line: i + 1, name: rest.slice(0, sp), style: {}, rejected: [] };
		for (const part of rest.slice(sp).split(',')) {
			const p = part.trim().replace(/;$/, '');
			if (!p) continue;
			const colon = p.indexOf(':');
			const prop = (colon < 0 ? p : p.slice(0, colon)).trim().toLowerCase();
			const value = colon < 0 ? '' : p.slice(colon + 1).trim();
			if (STYLE_VALUE.get(prop)?.test(value)) def.style[prop] = value;
			else def.rejected.push(p);
		}
		out.push(def);
	});
	return out;
}

// ---- groups: `%% group <name> [label [dx, dy]] <members>` ------------------------------------

/**
 * A group of components, drawn as one boundary around them and their links (DEV.md → "Groups
 * for wardley-beta"): `%% group "Human + AI" Staff, Cup of Tea, Cup`. The proposed statement,
 * commented out until wardley-beta has it; deleting `%% ` is meant to be the migration. The
 * name comes first, quoted when it holds blanks, then optionally `label` (the name is drawn as a
 * label; `label [dx, dy]` moves it from where the plugin places it); several lines with one name
 * make one group. Members are element names; a link belongs to a group when both its ends do.
 * Classes are set on a group by its name (`%% class "Human + AI" highlight`), as Mermaid sets
 * them on a flowchart's subgraph.
 */
const GROUP_HEAD = /^[ \t]*%%[ \t]*group[ \t]+/;
/** Characters of a group name. */
export const MAX_GROUP_NAME = 60;
/** A label offset, `[dx, dy]` in drawing units. Anchored, and blanks and digits never overlap: linear. */
const LABEL_OFFSET = /^\[[ \t]*(-?\d{1,4}(?:\.\d{1,2})?)[ \t]*,[ \t]*(-?\d{1,4}(?:\.\d{1,2})?)[ \t]*\]$/;

export type LabelOffset = [number, number];
/** The largest offset `LABEL_OFFSET` reads back, so the writer never writes one it would refuse. */
const MAX_LABEL_OFFSET = 9999;
/**
 * Characters XML forbids (C0 controls but tab and line breaks, U+FFFE, U+FFFF, lone surrogates):
 * a group's name is drawn as text, and one of these makes the SVG invalid XML (review 0.21.0).
 */
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface GroupLine {
	head: string;
	/** Null when a quoted name has no closing quote. */
	name: string | null;
	nameEnd: number;
	/** Where the members start: after the name and its label. */
	membersFrom: number;
	/** Null: no label; `label` alone is [0, 0]; `bad` when `label [` is not `label [dx, dy]`. */
	label: LabelOffset | 'bad' | null;
	targets: TargetSpan[];
}

/** A `%% group` line: its name, its label and its member targets. Null for any other line. */
function groupLine(l: string): GroupLine | null {
	if (l.length > MAX_LINE) return null;
	const head = GROUP_HEAD.exec(l)?.[0];
	if (!head) return null;
	const end = trimTail(l).length;
	let i = head.length;
	const q = l[i];
	let name: string | null;
	if (q === '"' || q === "'") {
		const close = l.indexOf(q, i + 1);
		if (close < 0 || close >= end) return { head, name: null, nameEnd: end, membersFrom: end, label: null, targets: [] };
		name = l.slice(i + 1, close);
		i = close + 1;
	} else {
		while (i < end && !isBlank(l[i])) i++;
		name = l.slice(head.length, i);
	}
	const nameEnd = i;
	// `label` right after the name is always the keyword (a member named "label maker" is quoted
	// there), alone or with its offset; `labels` is a member.
	let label: GroupLine['label'] = null;
	let j = i;
	while (j < end && isBlank(l[j])) j++;
	if (l.startsWith('label', j) && (j + 5 >= end || isBlank(l[j + 5]) || l[j + 5] === '[')) {
		let k = j + 5;
		while (k < end && isBlank(l[k])) k++;
		if (l[k] === '[') {
			const close = l.indexOf(']', k);
			const m = close > 0 && close < end ? LABEL_OFFSET.exec(l.slice(k, close + 1)) : null;
			if (m) { label = [Number(m[1]), Number(m[2])]; i = close + 1; } else label = 'bad';
		} else {
			label = [0, 0];
			i = j + 5;
		}
	}
	const rest = l.slice(i, end);
	return { head, name, nameEnd, membersFrom: i, label, targets: label !== 'bad' && rest.trim() ? scanTargets(l, i, end) : [] };
}

/** Why a group line adds nothing to its group, or undefined. */
function groupProblem(g: GroupLine): string | undefined {
	return g.name === null ? 'the group name has no closing quote.'
		: !g.name.trim() ? 'no group name, write %% group "<name>" <member>, <member>.'
			: g.name.length > MAX_GROUP_NAME ? `the group name is longer than ${MAX_GROUP_NAME} characters.`
				: g.name !== g.name.trim() ? 'the group name starts or ends with a blank.'
				: XML_FORBIDDEN.test(g.name) ? 'the group name holds a control character.'
				: g.label === 'bad' ? 'the label offset is not label [dx, dy].'
					: !g.targets.length ? `no members, write %% group ${g.name.includes(' ') ? `"${g.name}"` : g.name} <member>, <member>.`
						: g.targets.some(t => t.link) ? 'a link cannot be a member: a link belongs to the group when both its ends do.'
							: g.targets.some(t => t.names.length !== 1) ? 'an empty name in its members.' : undefined;
}

export interface GroupMarker {
	line: number;
	name: string;
	members: string[];
	label?: LabelOffset;
	/** Why the line adds nothing to its group. */
	problem?: string;
}

/** Every `%% group` line with its 1-based line. */
export function groupMarkers(source: string): GroupMarker[] {
	const out: GroupMarker[] = [];
	source.split('\n').forEach((l, i) => {
		const g = groupLine(l);
		if (!g) return;
		const members = g.targets.filter(t => !t.link && t.names.length === 1).map(t => t.names[0].name);
		const problem = groupProblem(g);
		out.push({ line: i + 1, name: g.name ?? '', members, ...(Array.isArray(g.label) ? { label: g.label } : {}), ...(problem ? { problem } : {}) });
	});
	return out;
}

export interface Group {
	name: string;
	members: string[];
	/** The line of the group's first statement. */
	line: number;
	/** Present when the name is drawn as a label: the first offset among its lines ([0, 0] for `label` alone). */
	label?: LabelOffset;
}

/** The groups of a map, lines with one name merged, members once each, in source order. */
export function groupsOf(source: string): Group[] {
	const groups = new Map<string, Group & { seen: Set<string> }>();
	for (const m of groupMarkers(source)) {
		if (m.problem) continue;
		const g = groups.get(m.name) ?? { name: m.name, members: [], line: m.line, seen: new Set<string>() };
		groups.set(m.name, g);
		if (m.label && !g.label) g.label = m.label;
		for (const n of m.members) if (!g.seen.has(n)) { g.seen.add(n); g.members.push(n); }
	}
	return [...groups.values()].map(({ seen: _, ...g }) => g);
}

/**
 * Rewrites the members of every `%% group` line: `f` answers undefined to keep a member, null
 * to drop it, a name to write instead; `only` limits it to one group. Names are replaced in place;
 * a line that lost a member is written anew (name and label kept), and one left without members
 * is removed.
 */
function editGroupMembers(lines: string[], f: (member: string) => string | null | undefined, only?: string): string[] {
	const out: string[] = [];
	for (const l of lines) {
		const g = groupLine(l);
		if (!g || !g.targets.length || (only !== undefined && g.name !== only)) { out.push(l); continue; }
		const parts = g.targets.map(t => ({ t, r: !t.link && t.names.length === 1 ? f(t.names[0].name) : undefined }));
		if (parts.every(p => p.r === undefined)) { out.push(l); continue; }
		const write = (p: { t: TargetSpan; r: string | null | undefined }, text: string) =>
			(typeof p.r === 'string' && p.r !== p.t.names[0].name ? formatName(p.r) : text);
		if (parts.some(p => p.r === null)) {
			const kept = parts.filter(p => p.r !== null).map(p => write(p, l.slice(p.t.start, p.t.end)));
			if (kept.length) out.push(`${trimTail(l.slice(0, g.membersFrom))} ${kept.join(', ')}`);
			continue;
		}
		let text = l;
		for (let k = parts.length - 1; k >= 0; k--) {
			const p = parts[k];
			text = text.slice(0, p.t.start) + write(p, l.slice(p.t.start, p.t.end)) + text.slice(p.t.end);
		}
		out.push(text);
	}
	return out;
}

/**
 * Takes out the class targets of groups an edit removed (their last member went with it), so
 * no `%% class` line is left naming nothing. A name that is also declared as an element keeps
 * its classes: those belong to the element.
 */
function withoutVanishedGroups(before: string[], after: string[]): string[] {
	const left = new Set(groupsOf(after.join('\n')).map(g => g.name));
	const gone = new Set(groupsOf(before.join('\n')).map(g => g.name).filter(n => !left.has(n)));
	if (!gone.size) return after;
	const declared = new Set(after.flatMap(l => nameSpans(l).filter(s => s.declaration).map(s => s.name)));
	return editClassTargets(after, t => (typeof t === 'string' && gone.has(t) && !declared.has(t) ? null : undefined));
}

/** Whether a group of that name exists (a line that sets nothing does not count). */
export function isGroup(source: string, name: string): boolean {
	return groupsOf(source).some(g => g.name === name);
}

/** The indexes of a group's lines that add to it (a line with a problem adds nothing). */
function groupLinesOf(lines: string[], name: string): number[] {
	const out: number[] = [];
	lines.forEach((l, i) => { const g = groupLine(l); if (g && g.name === name && !groupProblem(g)) out.push(i); });
	return out;
}

function requireGroup(lines: string[], name: string): number[] {
	const at = groupLinesOf(lines, name);
	if (!at.length) throw new EditError(`There is no group "${name}" in this map.`);
	return at;
}

const isDeclared = (lines: string[], name: string) => lines.some(l => nameSpans(l).some(s => s.declaration && s.name === name));

/** A group name as a group line writes it: bare when it is one plain word, else quoted. */
export function formatGroupName(name: string): string {
	if (/^[A-Za-z0-9_.+-]+$/.test(name)) return name;
	if (!name.includes('"')) return `"${name}"`;
	if (!name.includes("'")) return `'${name}'`;
	throw new EditError('A group name cannot contain both kinds of quotes.');
}

/** Refuses a name a new or renamed group cannot have. */
function checkGroupName(lines: string[], name: string) {
	if (!name.trim()) throw new EditError('The group needs a name.');
	if (name !== name.trim()) throw new EditError('A group name cannot start or end with a blank.');
	if (name.length > MAX_GROUP_NAME) throw new EditError(`A group name has at most ${MAX_GROUP_NAME} characters.`);
	if (/[\r\n]/.test(name) || XML_FORBIDDEN.test(name)) throw new EditError('A group name cannot hold line breaks or control characters.');
	if (groupLinesOf(lines, name).length) throw new EditError(`There is already a group "${name}" in this map.`);
	if (isDeclared(lines, name)) throw new EditError(`"${name}" is the name of an element in this map.`);
}

/** The first free name "Group 1", "Group 2", … (no group or element has it). */
export function nextGroupName(source: string): string {
	const taken = new Set(groupsOf(source).map(g => g.name));
	for (const l of source.split('\n')) for (const s of nameSpans(l)) if (s.declaration) taken.add(s.name);
	for (let n = 1; ; n++) if (!taken.has(`Group ${n}`)) return `Group ${n}`;
}

/**
 * Adds an element to a group: at the end of the group's first line, or, for a new group, as a
 * line of its own (after the last group line, else after the last class line, else at the end of
 * the map). A member already in the group leaves the source as it is.
 */
export function addGroupMember(source: string, group: string, member: string): string {
	const lines = source.split('\n');
	findDeclaration(lines, member);
	const at = groupLinesOf(lines, group);
	if (at.length) {
		if (groupsOf(source).find(g => g.name === group)!.members.includes(member)) return source;
		lines[at[0]] = `${trimTail(lines[at[0]])}, ${formatName(member)}`;
		return lines.join('\n');
	}
	checkGroupName(lines, group);
	const line = `%% group ${formatGroupName(group)} ${formatName(member)}`;
	let after = -1;
	lines.forEach((l, i) => { if (groupLine(l)) after = i; });
	if (after < 0) lines.forEach((l, i) => { if (classLine(l)) after = i; });
	if (after >= 0) {
		lines.splice(after + 1, 0, `${/^[ \t]*/.exec(lines[after])?.[0] ?? ''}${line}`);
	} else {
		let end = lines.length;
		while (end > 0 && lines[end - 1].trim() === '') end--;
		lines.splice(end, 0, line);
	}
	return lines.join('\n');
}

/** Takes an element out of a group; a group left without members goes, with its class targets. */
export function removeGroupMember(source: string, group: string, member: string): string {
	const lines = source.split('\n');
	requireGroup(lines, group);
	return withoutVanishedGroups(lines, editGroupMembers(lines, m => (m === member ? null : undefined), group)).join('\n');
}

/** Renames a group in each of its lines and in the class lines naming it. */
export function renameGroup(source: string, from: string, to: string): string {
	if (to === from) return source;
	const lines = source.split('\n');
	requireGroup(lines, from);
	checkGroupName(lines, to);
	const written = formatGroupName(to);
	const renamed = lines.map(l => {
		const g = groupLine(l);
		return g && g.name === from ? l.slice(0, g.head.length) + written + l.slice(g.nameEnd) : l;
	});
	// A class line naming an element of that name belongs to the element (wardley-read reports the clash).
	if (isDeclared(lines, from)) return renamed.join('\n');
	return editClassTargets(renamed, t => (t === from ? [to] : undefined)).join('\n');
}

/** Deletes a group: its lines and the class targets naming it. Its members stay in the map. */
export function deleteGroup(source: string, name: string): string {
	const lines = source.split('\n');
	requireGroup(lines, name);
	return withoutVanishedGroups(lines, lines.filter(l => groupLine(l)?.name !== name)).join('\n');
}

/**
 * Shows, moves or hides a group's label. An offset (rounded, within what the parser reads back)
 * or `auto` (the plugin's spot) is written after the name on the first line that has a label,
 * else on the group's first line; null takes the label off every line of the group.
 */
export function setGroupLabel(source: string, name: string, label: LabelOffset | 'auto' | null): string {
	const lines = source.split('\n');
	const at = requireGroup(lines, name);
	if (label === null) {
		for (const i of at) {
			const g = groupLine(lines[i])!;
			if (g.label) lines[i] = lines[i].slice(0, g.nameEnd) + lines[i].slice(g.membersFrom);
		}
		return lines.join('\n');
	}
	let written = 'label';
	if (label !== 'auto') {
		const [dx, dy] = label;
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new EditError('The label offset must be a number.');
		// Within what the parser reads back: a larger offset would make the line set nothing (review 0.21.0).
		const clamp = (v: number) => Math.max(-MAX_LABEL_OFFSET, Math.min(MAX_LABEL_OFFSET, Math.round(v)));
		written = `label [${clamp(dx)}, ${clamp(dy)}]`;
	}
	const i = at.find(k => groupLine(lines[k])!.label) ?? at[0];
	const l = lines[i], g = groupLine(l)!;
	lines[i] = `${l.slice(0, g.nameEnd)} ${written}${g.label ? l.slice(g.membersFrom) : l.slice(g.nameEnd)}`;
	return lines.join('\n');
}

/**
 * Adds an anchor or component at [visibility, evolution], after the last top-level
 * declaration. The name must be new.
 */
export function addElement(source: string, kind: 'anchor' | 'component', name: string, visibility: number, evolution: number): string {
	const lines = source.split('\n');
	const n = name.trim();
	if (lines.some(l => nameSpans(l).some(s => s.declaration && s.name === n))) throw new EditError(`"${n}" already exists in this map.`);
	if (isGroup(source, n)) throw new EditError(`"${n}" is the name of a group in this map.`);
	insertAfterLast(lines, `${kind} ${formatName(n)} [${fmt(visibility)}, ${fmt(evolution)}]`,
		topLevelDeclaration(lines), l => /^[ \t]*(title|size|evolution)\b/.test(l), l => /^[ \t]*wardley-beta/.test(l));
	return lines.join('\n');
}

/** Adds `note "text" [visibility, evolution]` after the last note, or at the end. */
export function addNote(source: string, text: string, visibility: number, evolution: number): string {
	const t = text.trim().replace(/[\r\n]+/g, ' ');
	if (!t) throw new EditError('The note must not be empty.');
	if (t.includes('"')) throw new EditError('A note cannot contain double quotes.');
	const lines = source.split('\n');
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === '') end--;
	const tail = lines.splice(end);
	insertAfterLast(lines, `note "${t}" [${fmt(visibility)}, ${fmt(evolution)}]`, l => /^[ \t]*note[ \t]/.test(l), () => false);
	return [...lines, ...tail].join('\n');
}

/** Moves the note whose text is exactly `text` (it must occur once). */
export function setNotePosition(source: string, text: string, visibility: number, evolution: number): string {
	const lines = source.split('\n');
	const hits: { i: number; end: number }[] = [];
	lines.forEach((l, i) => {
		const m = /^([ \t]*note[ \t]+)("[^"]*"|'[^']*')/.exec(l);
		if (m && m[2].slice(1, -1) === text) hits.push({ i, end: m[0].length });
	});
	if (hits.length === 0) throw new EditError(`No note "${text}" in this map.`);
	if (hits.length > 1) throw new EditError(`The note "${text}" occurs ${hits.length} times, edit it in the source.`);
	const { i, end } = hits[0];
	const after = lines[i].slice(end);
	const m = position(after);
	if (!m) throw new EditError(`The note "${text}" has no position.`);
	lines[i] = lines[i].slice(0, end) + `${m[1]}${fmt(visibility)}${m[3]},${m[4] ?? ' '}${fmt(evolution)}${m[6] ?? ''}]` + after.slice(m[0].length);
	return lines.join('\n');
}

/** Deletes the note whose text is exactly `text` (it must occur once). */
export function deleteNote(source: string, text: string): string {
	const lines = source.split('\n');
	const hits = lines.map((l, i) => { const m = /^[ \t]*note[ \t]+("[^"]*"|'[^']*')/.exec(l); return m && m[1].slice(1, -1) === text ? i : -1; }).filter(i => i >= 0);
	if (hits.length === 0) throw new EditError(`No note "${text}" in this map.`);
	if (hits.length > 1) throw new EditError(`The note "${text}" occurs ${hits.length} times, edit it in the source.`);
	lines.splice(hits[0], 1);
	return lines.join('\n');
}

// ---- annotations ----------------------------------------------------------------------

/**
 * `annotation N,[v, e] "text"`: Mermaid draws a numbered circle at the position and lists the
 * text in the box that `annotations [v, e]` places. Answers the number, where the position
 * starts (`at`, the parts from `position()`) and the quoted text's span. Index scans after a
 * fixed head, no backtracking (review F2).
 */
function annotationLine(l: string): { number: number; at: number; pos: string[]; text: [number, number] } | null {
	const m = /^[ \t]*annotation[ \t]+(\d+)[ \t]*,/.exec(l);
	if (!m) return null;
	const at = m[0].length;
	const pos = position(l.slice(at));
	if (!pos || pos[5] === undefined) return null;
	let i = at + pos[0].length;
	while (i < l.length && isBlank(l[i])) i++;
	const q = l[i];
	if (q !== '"' && q !== "'") return null;
	const close = l.indexOf(q, i + 1);
	return close < 0 ? null : { number: Number(m[1]), at, pos, text: [i, close + 1] };
}

/** Line index of the single annotation numbered `n`. */
function findAnnotation(lines: string[], n: number): number {
	const hits = lines.map((l, i) => (annotationLine(l)?.number === n ? i : -1)).filter(i => i >= 0);
	if (hits.length === 0) throw new EditError(`No annotation ${n} in this map.`);
	if (hits.length > 1) throw new EditError(`Annotation ${n} occurs ${hits.length} times, edit it in the source.`);
	return hits[0];
}

const ANNOTATIONS_BOX = /^[ \t]*annotations[ \t]*\[/;

/** One line of annotation text: no line breaks, and no double quotes (they end the string). */
function annotationText(text: string): string {
	const t = text.trim().replace(/[\r\n]+/g, ' ');
	if (!t) throw new EditError('The annotation must not be empty.');
	if (t.includes('"')) throw new EditError('An annotation cannot contain double quotes.');
	return t;
}

/** The text of annotation `n`, without its quotes. */
export function getAnnotation(source: string, n: number): string {
	const lines = source.split('\n');
	const l = lines[findAnnotation(lines, n)];
	const [from, to] = annotationLine(l)!.text;
	return l.slice(from + 1, to - 1);
}

/** Moves the numbered circle of annotation `n`. */
export function setAnnotationPosition(source: string, n: number, visibility: number, evolution: number): string {
	const lines = source.split('\n');
	const i = findAnnotation(lines, n);
	const l = lines[i], { at, pos: m } = annotationLine(l)!;
	lines[i] = l.slice(0, at) + `${m[1]}${fmt(visibility)}${m[3]},${m[4]}${fmt(evolution)}${m[6]}]` + l.slice(at + m[0].length);
	return lines.join('\n');
}

/** Replaces the text of annotation `n`. */
export function setAnnotationText(source: string, n: number, text: string): string {
	const t = annotationText(text);
	const lines = source.split('\n');
	const i = findAnnotation(lines, n);
	const l = lines[i], [from, to] = annotationLine(l)!.text;
	lines[i] = `${l.slice(0, from)}"${t}"${l.slice(to)}`;
	return lines.join('\n');
}

/** Deletes annotation `n`; with the last one goes the `annotations` box, which would list nothing. */
export function deleteAnnotation(source: string, n: number): string {
	const lines = source.split('\n');
	lines.splice(findAnnotation(lines, n), 1);
	if (!lines.some(l => annotationLine(l))) return lines.filter(l => !ANNOTATIONS_BOX.test(l)).join('\n');
	return lines.join('\n');
}

/**
 * Adds annotation N+1 (one above the highest number) at [visibility, evolution], after the last
 * annotation, else at the end. Without an `annotations` box the text would not be shown, so one
 * is added in the top left corner (Mermaid keeps the box inside the map).
 */
export function addAnnotation(source: string, text: string, visibility: number, evolution: number): string {
	const t = annotationText(text);
	const lines = source.split('\n');
	const number = Math.max(0, ...lines.map(l => annotationLine(l)?.number ?? 0)) + 1;
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === '') end--;
	const tail = lines.splice(end);
	if (!lines.some(l => ANNOTATIONS_BOX.test(l))) {
		insertAfterLast(lines, 'annotations [0.97, 0.03]', l => annotationLine(l) !== null, () => false);
	}
	insertAfterLast(lines, `annotation ${number},[${fmt(visibility)}, ${fmt(evolution)}] "${t}"`,
		l => annotationLine(l) !== null, l => ANNOTATIONS_BOX.test(l));
	return [...lines, ...tail].join('\n');
}

/** Moves the box that lists the annotation texts (`annotations [v, e]`, its top left corner). */
export function setAnnotationsBoxPosition(source: string, visibility: number, evolution: number): string {
	const lines = source.split('\n');
	const hits = lines.map((l, i) => (ANNOTATIONS_BOX.test(l) ? i : -1)).filter(i => i >= 0);
	if (hits.length === 0) throw new EditError('This map has no annotations box.');
	if (hits.length > 1) throw new EditError(`The annotations box is declared ${hits.length} times, edit it in the source.`);
	const l = lines[hits[0]], at = l.indexOf('annotations') + 'annotations'.length;
	const m = position(l.slice(at));
	if (!m || m[5] === undefined) throw new EditError('The annotations box has no position.');
	lines[hits[0]] = l.slice(0, at) + `${m[1]}${fmt(visibility)}${m[3]},${m[4]}${fmt(evolution)}${m[6]}]` + l.slice(at + m[0].length);
	return lines.join('\n');
}

/** Sets the map's `title` line, or adds one right after `wardley-beta`; an empty title removes it. */
export function setTitle(source: string, title: string): string {
	const t = title.replace(/[\r\n]+/g, ' ').trim();
	const lines = source.split('\n');
	const at = lines.findIndex(l => /^[ \t]*title([ \t]|$)/.test(l));
	if (at >= 0) {
		if (t) lines[at] = `${/^[ \t]*/.exec(lines[at])?.[0] ?? ''}title ${t}`;
		else lines.splice(at, 1);
	} else if (t) {
		const head = lines.findIndex(l => /^[ \t]*wardley-beta/.test(l));
		lines.splice(head + 1, 0, `title ${t}`);
	}
	return lines.join('\n');
}

export type Method = 'build' | 'buy' | 'outsource' | 'market';
const LABEL_AFTER = /^[ \t]+label[ \t]*\[[^\]]*\]/;
const METHOD_AFTER = /^([ \t]+)\((build|buy|outsource|market)\)/;

/**
 * A component's sourcing decorator, null for none. Throws for anchors and pipeline
 * components, which have none in wardley-beta.
 */
export function getMethod(source: string, name: string): Method | null {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	if (span.kind === 'anchor') throw new EditError('Anchors have no sourcing method.');
	const text = lines[line];
	const pos = position(text.slice(span.end));
	if (!pos || pos[5] === undefined) throw new EditError(`"${name}" has no sourcing method in wardley-beta.`);
	let at = span.end + pos[0].length;
	const label = LABEL_AFTER.exec(text.slice(at));
	if (label) at += label[0].length;
	return (METHOD_AFTER.exec(text.slice(at))?.[2] as Method | undefined) ?? null;
}

/**
 * Sets or removes a component's sourcing decorator `(build)`, `(buy)`, `(outsource)` or
 * `(market)`. It sits after the position and label offset, before `(inertia)`.
 */
export function setMethod(source: string, name: string, method: Method | null): string {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, name);
	if (span.kind === 'anchor') throw new EditError('Anchors have no sourcing method, pick a component.');
	const text = lines[line];
	const after = text.slice(span.end);
	const pos = position(after);
	if (!pos) throw new EditError(`"${name}" has no position.`);
	if (pos[5] === undefined) throw new EditError(`"${name}" is a pipeline component, which has no sourcing method in wardley-beta.`);
	let at = span.end + pos[0].length;
	const label = LABEL_AFTER.exec(text.slice(at));
	if (label) at += label[0].length;
	const existing = METHOD_AFTER.exec(text.slice(at));
	const end = existing ? at + existing[0].length : at;
	lines[line] = text.slice(0, at) + (method ? ` (${method})` : '') + text.slice(end);
	return lines.join('\n');
}

// ---- accelerators / deaccelerators --------------------------------------------------

export type ForceKind = 'accelerator' | 'deaccelerator';
const FORCE = /^([ \t]*)(accelerator|deaccelerator)[ \t]+("[^"]*"|'[^']*'|.+?)([ \t]*\[[^\]]*\])(.*)$/;

/** Line index of the single `<kind> <name> [v, e]`. */
function findForce(lines: string[], kind: ForceKind, name: string): number {
	const hits = lines.map((l, i) => { const m = FORCE.exec(l); return m && m[2] === kind && unquote(m[3].trim()) === name ? i : -1; }).filter(i => i >= 0);
	if (hits.length === 0) throw new EditError(`No ${kind} "${name}" in this map.`);
	if (hits.length > 1) throw new EditError(`The ${kind} "${name}" occurs ${hits.length} times, edit it in the source.`);
	return hits[0];
}

/** Adds an accelerator or deaccelerator after the last one, else at the end of the map. */
export function addForce(source: string, kind: ForceKind, name: string, visibility: number, evolution: number): string {
	const n = name.trim();
	if (!n) throw new EditError('The name must not be empty.');
	const lines = source.split('\n');
	if (lines.some(l => { const m = FORCE.exec(l); return m && m[2] === kind && unquote(m[3].trim()) === n; })) {
		throw new EditError(`The ${kind} "${n}" already exists in this map.`);
	}
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === '') end--;
	const tail = lines.splice(end);
	insertAfterLast(lines, `${kind} ${formatName(n)} [${fmt(visibility)}, ${fmt(evolution)}]`, l => FORCE.test(l), () => false);
	return [...lines, ...tail].join('\n');
}

export function setForcePosition(source: string, kind: ForceKind, name: string, visibility: number, evolution: number): string {
	const lines = source.split('\n');
	const i = findForce(lines, kind, name);
	const m = FORCE.exec(lines[i])!;
	lines[i] = `${m[1]}${m[2]} ${m[3].trim()} [${fmt(visibility)}, ${fmt(evolution)}]${m[5]}`;
	return lines.join('\n');
}

export function renameForce(source: string, kind: ForceKind, oldName: string, newName: string): string {
	const lines = source.split('\n');
	const i = findForce(lines, kind, oldName);
	const n = newName.trim();
	if (n === oldName) return source;
	if (lines.some(l => { const m = FORCE.exec(l); return m && m[2] === kind && unquote(m[3].trim()) === n; })) {
		throw new EditError(`The ${kind} "${n}" already exists in this map.`);
	}
	const m = FORCE.exec(lines[i])!;
	lines[i] = `${m[1]}${m[2]} ${formatName(n)}${m[4]}${m[5]}`;
	return lines.join('\n');
}

export function deleteForce(source: string, kind: ForceKind, name: string): string {
	const lines = source.split('\n');
	lines.splice(findForce(lines, kind, name), 1);
	return lines.join('\n');
}

// ---- pipelines ----------------------------------------------------------------------

/** The `pipeline <parent> {` … `}` block of a parent: first and last line index. */
function findPipeline(lines: string[], parent: string): { open: number; close: number } | null {
	const open = lines.findIndex(l => /^[ \t]*pipeline[ \t]/.test(l) && nameSpans(l)[0]?.name === parent);
	if (open < 0) return null;
	const close = lines.findIndex((l, i) => i > open && /^[ \t]*\}/.test(l));
	if (close < 0) throw new EditError(`The pipeline of "${parent}" is not closed.`);
	return { open, close };
}

/** Names of a parent's pipeline components, or null when it has no pipeline. */
export function pipelineOf(source: string, parent: string): string[] | null {
	const lines = source.split('\n');
	const b = findPipeline(lines, parent);
	if (!b) return null;
	return lines.slice(b.open + 1, b.close).flatMap(l => nameSpans(l).filter(s => s.declaration).map(s => s.name));
}

/**
 * Adds `child` at `evolution` to the pipeline of `parent`, creating the pipeline (after the
 * parent's declaration) when it has none. Pipeline components carry only their evolution.
 */
export function addToPipeline(source: string, parent: string, child: string, evolution: number): string {
	const lines = source.split('\n');
	const { line, span } = findDeclaration(lines, parent);
	if (span.kind === 'anchor') throw new EditError('Anchors cannot have a pipeline, pick a component.');
	const c = child.trim();
	if (!c) throw new EditError('The name must not be empty.');
	if (lines.some(l => nameSpans(l).some(s => s.declaration && s.name === c))) throw new EditError(`"${c}" already exists in this map.`);
	const indent = /^[ \t]*/.exec(lines[line])?.[0] ?? '';
	const entry = `${indent}  component ${formatName(c)} [${fmt(evolution)}]`;
	const b = findPipeline(lines, parent);
	if (b) {
		lines.splice(b.close, 0, entry);
	} else {
		let at = line;
		while (at + 1 < lines.length && inertiaComment(lines[at + 1]) !== null) at++;
		lines.splice(at + 1, 0, `${indent}pipeline ${formatName(parent)} {`, entry, `${indent}}`);
	}
	return lines.join('\n');
}

/** Removes the pipeline of `parent` with its components; the parent itself stays. */
export function deletePipeline(source: string, parent: string): string {
	const lines = source.split('\n');
	const b = findPipeline(lines, parent);
	if (!b) throw new EditError(`"${parent}" has no pipeline.`);
	const children = lines.slice(b.open + 1, b.close).flatMap(l => nameSpans(l).filter(s => s.declaration).map(s => s.name));
	let out = lines.filter((_, i) => i < b.open || i > b.close);
	// Links and evolve arrows of the removed components would otherwise stay behind: Mermaid
	// silently skips them, and a later component of the same name would inherit them.
	out = out.filter(l => !(linkPair(l)?.some(s => children.includes(s.name)))
		&& !(/^[ \t]*evolve[ \t]/.test(l) && children.includes(nameSpans(l)[0]?.name ?? '')));
	out = editClassTargets(out, t => (children.some(c => touches(t, c)) ? null : undefined));
	return withoutVanishedGroups(out, editGroupMembers(out, m => (children.includes(m) ? null : undefined))).join('\n');
}

/** Shifts every component of a parent's pipeline by `delta` evolution (moving the box). */
export function shiftPipeline(source: string, parent: string, delta: number): string {
	const lines = source.split('\n');
	const b = findPipeline(lines, parent);
	if (!b) return source;
	for (let i = b.open + 1; i < b.close; i++) {
		lines[i] = lines[i].replace(/\[[ \t]*([-\d.]+)[ \t]*\]/, (_, v) => `[${fmt(Number(v) + delta)}]`);
	}
	return lines.join('\n');
}

/** Every declared anchor/component with its position (pipeline children carry no visibility). */
export function declaredPositions(source: string): { name: string; kind: 'anchor' | 'component'; visibility?: number; evolution: number }[] {
	const out: { name: string; kind: 'anchor' | 'component'; visibility?: number; evolution: number }[] = [];
	for (const l of source.split('\n')) {
		for (const s of nameSpans(l)) {
			if (!s.declaration) continue;
			try { out.push({ name: s.name, kind: s.kind!, ...getPosition(source, s.name) }); } catch { /* duplicate or no position */ }
		}
	}
	return out;
}

/**
 * Deletes an anchor or component with everything that refers to it: its links, its evolve
 * arrow, the classes set on it or its links, and its group memberships. A pipeline parent is
 * refused (its pipeline block would dangle).
 */
export function deleteElement(source: string, name: string): string {
	let lines = source.split('\n');
	const { line } = findDeclaration(lines, name);
	if (lines.some(l => /^[ \t]*pipeline[ \t]/.test(l) && nameSpans(l)[0]?.name === name)) {
		throw new EditError(`"${name}" has a pipeline, remove the pipeline in the source first.`);
	}
	const evolve = findEvolve(lines, name);
	// The last component of a pipeline takes the (then empty, invalid) pipeline block with it.
	const parentLine = lines.slice(0, line).map((l, i) => ({ l, i })).reverse().find(({ l }) => /^[ \t]*pipeline[ \t]/.test(l) || /^[ \t]*\}/.test(l));
	if (parentLine && /^[ \t]*pipeline[ \t]/.test(parentLine.l)) {
		const parent = nameSpans(parentLine.l)[0]?.name;
		if (parent && pipelineOf(lines.join('\n'), parent)?.length === 1) return deletePipeline(source, parent);
	}
	lines = lines.filter((l, i) => i !== line && i !== evolve && !(linkPair(l)?.some(s => s.name === name)));
	lines = editClassTargets(withoutInertiaPosition(lines, name), t => (touches(t, name) ? null : undefined));
	return withoutVanishedGroups(lines, editGroupMembers(lines, m => (m === name ? null : undefined))).join('\n');
}

/** How a link is drawn: a plain or dashed line, or a flow arrow in one or both directions. */
export type LinkKind = 'line' | 'dashed' | 'forward' | 'backward' | 'both';
const ARROW_OF: Record<LinkKind, string> = { line: '->', dashed: '-.->', forward: '+>', backward: '+<', both: '+<>' };

export interface LinkInfo {
	/** Names as written, in source order: `from <arrow> to`. */
	from: string;
	to: string;
	kind: LinkKind;
	/** The `; label` or a flow's inline `+'label'>` label; '' when none. */
	label: string;
}

/**
 * How an arrow is drawn. The direction is read without the inline label (`+'a<b'>` is forward):
 * the one place that knows the arrow forms, for the dialog, the model and `orient`.
 */
export function linkKindOf(arrow: string): LinkKind {
	const bare = arrow.replace(/^\+'[^']*'|^\+"[^"]*"/, '+');
	if (bare.startsWith('+')) return bare.includes('<>') ? 'both' : bare.includes('<') ? 'backward' : 'forward';
	return bare.includes('.') ? 'dashed' : 'line';
}

/** Reads the link between `a` and `b` (either order). */
export function getLink(source: string, a: string, b: string): LinkInfo {
	const lines = source.split('\n');
	const { i, sp } = findLink(lines, a, b);
	const line = lines[i];
	const arrow = line.slice(sp[0].end, sp[1].start).trim();
	const after = line.slice(sp[1].end);
	const inline = /^\+'([^']*)'/.exec(arrow)?.[1] ?? /^\+"([^"]*)"/.exec(arrow)?.[1];
	const annotation = /^[ \t]*;(.*)$/.exec(after)?.[1].trim();
	return { from: sp[0].name, to: sp[1].name, kind: linkKindOf(arrow), label: (inline ?? annotation ?? '').trim() };
}

/**
 * Rewrites the link between `a` and `b`: its kind and its label (`; label`, omitted when
 * empty). An inline flow label is folded into the `; label` form; the order of the two
 * names is kept, so "forward" keeps meaning "towards the second name".
 */
export function setLink(source: string, a: string, b: string, kind: LinkKind, label: string, arrow?: string): string {
	const lines = source.split('\n');
	const { i, sp } = findLink(lines, a, b);
	const line = lines[i];
	const l = label.replace(/[\r\n]+/g, ' ').trim();
	const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
	// `arrow` writes an arrow exactly as given; an inline-label flow carries its label itself.
	const written = arrow ?? ARROW_OF[kind];
	const suffix = l && !/^\+'/.test(written) ? `; ${l}` : '';
	lines[i] = `${indent}${line.slice(sp[0].start, sp[0].end)} ${written} ${line.slice(sp[1].start, sp[1].end)}${suffix}`;
	return lines.join('\n');
}

/** Deletes the link between `a` and `b` (its whole line, label included) and the classes set on it. */
export function unlink(source: string, a: string, b: string): string {
	const lines = source.split('\n');
	const { i } = findLink(lines, a, b);
	lines.splice(i, 1);
	return editClassTargets(lines, t => (sameTarget(t, [a, b]) ? null : undefined)).join('\n');
}

/**
 * Adds `from -> to`, after the last link, or after the last declaration when the map has
 * no links yet. Refuses a self-link, an existing link and undeclared names.
 */
export function addLink(source: string, from: string, to: string): string {
	const lines = source.split('\n');
	findDeclaration(lines, from);
	findDeclaration(lines, to);
	if (from === to) throw new EditError(`"${from}" cannot be linked to itself.`);
	if (linked(lines, from, to)) throw new EditError(`"${from}" and "${to}" are already linked.`);
	let at = -1;
	lines.forEach((l, i) => { if (linkPair(l)) at = i; });
	if (at < 0) lines.forEach((l, i) => { if (nameSpans(l).some(s => s.declaration)) at = i; });
	const indent = at >= 0 ? (/^[ \t]*/.exec(lines[at])?.[0] ?? '') : '';
	lines.splice(at + 1, 0, `${indent}${formatName(from)} -> ${formatName(to)}`);
	return lines.join('\n');
}

/** Two visibilities closer than this count as level: such a link is left as written. */
const LEVEL = 0.005;

/**
 * Declared visibility per name; a pipeline component has its parent's (where Mermaid draws it
 * and `wardley-read` reports it). A name declared more than once has none. One pass, lookups only.
 */
function heights(lines: string[]): Map<string, number> {
	const vis = new Map<string, number>(), parentOf = new Map<string, string>(), twice = new Set<string>();
	let parent: string | null = null;
	for (const l of lines) {
		if (/^[ \t]*pipeline[ \t]/.test(l)) { parent = nameSpans(l)[0]?.name ?? null; continue; }
		if (/^[ \t]*\}/.test(l)) { parent = null; continue; }
		for (const s of nameSpans(l)) {
			if (!s.declaration) continue;
			if (vis.has(s.name) || parentOf.has(s.name)) twice.add(s.name);
			if (parent !== null) { parentOf.set(s.name, parent); continue; }
			const m = position(l.slice(s.end));
			if (m && m[5] !== undefined) vis.set(s.name, Number(m[2]));
		}
	}
	for (const [child, p] of parentOf) if (!vis.has(child) && vis.has(p)) vis.set(child, vis.get(p)!);
	for (const n of twice) vis.delete(n);
	return vis;
}

/** A flow arrow with one head (`+>`, `+<`, also with an inline label): its direction is a statement. */
const isDirected = (arrow: string) => { const k = linkKindOf(arrow); return k === 'forward' || k === 'backward'; };

/**
 * Writes the links without a direction of their own (`->`, `-->`, `-.->`, `+<>`) that `pick`
 * selects from the upper element to the lower one, so the text reads as the drawing does: a
 * plain `A -> B` says "A needs B", and a map is read from top to bottom. A link with one flow
 * head keeps its direction. The two names swap places in the line; arrow, label, indent stay,
 * and classes and groups name a link by its unordered pair. Left as written: a level link, an
 * end without a position, a pair linked twice. A pipeline parent and its own component are
 * level, which matters: Mermaid hides `Child -> Parent`, so swapping them would show the link.
 */
function orient(source: string, pick: (a: string, b: string) => boolean): string {
	const lines = source.split('\n');
	const vis = heights(lines);
	const pairs = new Map<string, number>();
	const key = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
	const links = lines.map(l => linkPair(l));
	for (const sp of links) if (sp) pairs.set(key(sp[0].name, sp[1].name), (pairs.get(key(sp[0].name, sp[1].name)) ?? 0) + 1);
	links.forEach((sp, i) => {
		if (!sp) return;
		const [a, b] = sp, line = lines[i];
		if (!pick(a.name, b.name) || pairs.get(key(a.name, b.name))! > 1) return;
		if (isDirected(line.slice(a.end, b.start).trim())) return;
		const va = vis.get(a.name), vb = vis.get(b.name);
		if (va === undefined || vb === undefined || va >= vb - LEVEL) return;
		lines[i] = swapped(line, a, b);
	});
	return lines.join('\n');
}

/** `orient` on every link of the named elements (they were moved, so their links may now run upwards). */
export function orientLinksOf(source: string, names: string[]): string {
	const set = new Set(names);
	return orient(source, (a, b) => set.has(a) || set.has(b));
}

/** `orient` on the one link between `a` and `b` (just drawn, re-linked or saved in its dialog). */
export function orientLink(source: string, a: string, b: string): string {
	return orient(source, (x, y) => (x === a && y === b) || (x === b && y === a));
}

/** The element the link between `a` and `b` comes from when read top to bottom: the upper one, or the first written when level. */
export function upperEnd(source: string, a: string, b: string): string {
	const lines = source.split('\n');
	const { sp } = findLink(lines, a, b);
	const vis = heights(lines);
	const [first, second] = [sp[0].name, sp[1].name];
	const v1 = vis.get(first), v2 = vis.get(second);
	return v1 !== undefined && v2 !== undefined && v1 < v2 - LEVEL ? second : first;
}

/**
 * How the link dialog shows a link, seen from its upper end `upper`: no head (`line`,
 * `dashed`), one head pointing `down` (away from the upper end) or `up`, or `both`.
 */
export type LinkDirection = 'line' | 'dashed' | 'down' | 'up' | 'both';

export function linkDirection(link: LinkInfo, upper: string): LinkDirection {
	if (link.kind === 'forward') return link.to === upper ? 'up' : 'down';
	if (link.kind === 'backward') return link.from === upper ? 'up' : 'down';
	return link.kind;
}

/**
 * Sets a link's direction and label as the dialog chose them. A flow arrow is always written
 * `source +> target`, so the order of the names is the arrow's direction; any other link is
 * written from the upper element to the lower one (`orientLink`).
 */
export function setLinkDirection(source: string, a: string, b: string, dir: LinkDirection, label: string, upper: string): string {
	if (dir !== 'down' && dir !== 'up') return orientLink(setLink(source, a, b, dir, label), a, b);
	const lower = upper === a ? b : a;
	const from = dir === 'down' ? upper : lower;
	const s = setLink(source, a, b, 'forward', label);
	return getLink(s, a, b).from === from ? s : swapLinkEnds(s, a, b);
}

/** Swaps the two names of the link between `a` and `b` in its line; everything else stays. */
function swapLinkEnds(source: string, a: string, b: string): string {
	const lines = source.split('\n');
	const { i, sp } = findLink(lines, a, b);
	lines[i] = swapped(lines[i], sp[0], sp[1]);
	return lines.join('\n');
}

/** `line` with its two name spans exchanged (quotes included), the arrow and the rest untouched. */
const swapped = (line: string, x: NameSpan, y: NameSpan) =>
	line.slice(0, x.start) + line.slice(y.start, y.end) + line.slice(x.end, y.start) + line.slice(x.start, x.end) + line.slice(y.end);

/** Renames an element everywhere in the map: declaration, links, evolve, pipeline, comments it is named in. */
export function rename(source: string, oldName: string, newName: string): string {
	const next = newName.trim();
	if (next === oldName) return source;
	const written = formatName(next);
	const lines = source.split('\n');
	findDeclaration(lines, oldName);
	if (lines.some(l => nameSpans(l).some(s => s.declaration && s.name === next))) {
		throw new EditError(`"${next}" already exists in this map.`);
	}
	if (isGroup(source, next)) throw new EditError(`"${next}" is the name of a group in this map.`);
	const renamed = lines.map(l => {
		const pos = inertiaComment(l);
		if (pos) return unquote(pos[2].trim()) === oldName ? `${pos[1]}${written}${pos[3]}${pos[4]}` : l;
		const spans = nameSpans(l).filter(s => s.name === oldName).sort((a, b) => b.start - a.start);
		for (const s of spans) l = l.slice(0, s.start) + written + l.slice(s.end);
		return l;
	});
	const classed = editClassTargets(renamed, t => (touches(t, oldName)
		? (typeof t === 'string' ? [next] : t.map(n => (n === oldName ? next : n)))
		: undefined));
	return editGroupMembers(classed, m => (m === oldName ? next : undefined)).join('\n');
}

// ---- helpers the editor needs, kept here because they are pure ------------------------

/**
 * Whether the map writes positions on Mermaid's 0-100 scale (it accepts both). The editor
 * works in 0-1 and would write a dragged `[50, 70]` back as `[1.00, 1.00]`, so such maps are
 * rendered but not made editable.
 */
export function usesPercentScale(source: string): boolean {
	for (const l of source.split('\n')) {
		if (!/^[ \t]*(anchor|component|note|accelerator|deaccelerator)\b/.test(l)) continue;
		const m = /\[[ \t]*([-\d.]+)[ \t]*(?:,[ \t]*([-\d.]+)[ \t]*)?\]/.exec(l.replace(/"[^"]*"|'[^']*'/g, ''));
		if (m && (Number(m[1]) > 1 || (m[2] !== undefined && Number(m[2]) > 1))) return true;
	}
	return false;
}

/**
 * Why a rendered map is not editable graphically, or null when it is. Such a map still
 * renders; it is just not tagged for the editor.
 */
export function editBlocker(source: string): string | null {
	if (source.length > MAX_SOURCE) return 'This map is too large to edit graphically, edit it in the source.';
	if (source.split('\n').some(l => l.length > MAX_LINE)) return 'A line of this map is too long to edit graphically, edit it in the source.';
	// Its lines are free text the line parsers would read as declarations and links (review F2).
	if (/^[ \t]*accDescr[ \t]*\{/m.test(source)) return 'Maps with a multi-line accDescr block are edited in the source.';
	if (usesPercentScale(source)) return 'This map uses the 0-100 scale, edit it in the source.';
	return null;
}

/** Whether a mermaid block body is a wardley-beta map (its first statement, after blanks and `%%` comments). */
export function isWardley(body: string): boolean {
	for (const l of body.split('\n')) {
		const t = l.trim();
		if (!t || t.startsWith('%%')) continue;
		return /^wardley-beta(?:[ \t]|$)/.test(t);
	}
	return false;
}

/** Parents of the `pipeline` blocks in source order (= the order Mermaid draws their boxes). */
export function pipelineParents(source: string): string[] {
	return source.split('\n').filter(l => /^[ \t]*pipeline[ \t]/.test(l)).map(l => nameSpans(l)[0]?.name ?? '');
}

/** Default target for a new evolve arrow: 0.2 to the right of the component, at most 1. */
export function defaultEvolveTarget(source: string, name: string): number {
	return Math.min(1, getPosition(source, name).evolution + 0.2);
}

/** Evolution for the next pipeline component: the parent's for the first, else right of the last. */
export function nextPipelineEvolution(source: string, parent: string): number {
	const kids = pipelineOf(source, parent);
	if (!kids?.length) return getPosition(source, parent).evolution;
	return Math.min(0.97, Math.max(...kids.map(k => getPosition(source, k).evolution)) + 0.1);
}

/**
 * A free place for a new element: anchors along the top, notes low on the right, everything
 * else near the middle, at least 0.08 away from every positioned element (notes,
 * (de)accelerators and annotation circles included).
 */
export function freeSpot(source: string, kind: 'anchor' | 'component' | 'note'): { visibility: number; evolution: number } {
	const taken: { visibility: number; evolution: number }[] = [];
	for (const p of declaredPositions(source)) if (p.visibility !== undefined) taken.push({ visibility: p.visibility, evolution: p.evolution });
	for (const l of source.split('\n')) {
		const m = /^[ \t]*(?:note|accelerator|deaccelerator)\b.*\[[ \t]*([-\d.]+)[ \t]*,[ \t]*([-\d.]+)[ \t]*\][ \t]*$/.exec(l);
		if (m) taken.push({ visibility: Number(m[1]), evolution: Number(m[2]) });
		const a = annotationLine(l);
		if (a) taken.push({ visibility: Number(a.pos[2]), evolution: Number(a.pos[5]) });
	}
	const steps = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4];
	const base = kind === 'anchor' ? { v: 0.95, e: 0.5 } : kind === 'note' ? { v: 0.1, e: 0.8 } : { v: 0.5, e: 0.5 };
	for (const dv of kind === 'anchor' ? [0] : steps) {
		for (const de of steps) {
			const v = Math.min(0.97, Math.max(0.03, base.v + dv)), e = Math.min(0.97, Math.max(0.03, base.e + de));
			if (taken.every(p => Math.hypot(p.visibility - v, p.evolution - e) >= 0.08)) return { visibility: v, evolution: e };
		}
	}
	return { visibility: base.v, evolution: base.e };
}
