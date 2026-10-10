/**
 * Pure text edits on a `wardley-beta` source (Mermaid 12.1 grammar). No DOM, no Obsidian:
 * every function takes the block's source and returns the new source or throws an
 * `EditError` whose message is shown to the user. The caller validates the result with
 * `mermaid.parse()` before writing it, so a gap in these rules cannot corrupt a note.
 */

export class EditError extends Error {}

/**
 * Mermaid's NAME_WITH_SPACES terminal: a name that needs no quotes. The lexer matches its
 * lowercase keywords as prefixes, so a bare name that merely starts with one (`builder`,
 * `notes`, `title`) fails to parse and has to be quoted (measured against 12.1).
 */
const KEYWORD_PREFIX = /^(?:wardley-beta|size|evolution|evolve|anchor|component|label|inertia|pipeline|note|annotations?|accelerator|deaccelerator|build|buy|outsource|market|title|accTitle|accDescr)/;
const BARE_NAME = /^[A-Za-z](?:[A-Za-z0-9_()&]|-(?!>))*(?:[ \t]+[A-Za-z(](?:[A-Za-z0-9_()&]|-(?!>))*)*$/;

/** Link and flow arrows, longest first so `-.->` is not read as `->` (sticky: tried at one index). */
const ARROW = /-\.->|-->|->|\+<>|\+<|\+>|\+'[^']*'>|\+"[^"]*">/y;

/**
 * Limits for graphical editing (security review on 0.12.0, F1/F2/F6). The parsers here are
 * linear, and these bounds keep the few remaining per-line regexes cheap. A map beyond them
 * still renders, it is just not editable (`editBlocker`).
 */
export const MAX_LINE = 1000;
export const MAX_SOURCE = 64 * 1024;

const isBlank = (c: string) => c === ' ' || c === '\t';
/** `s` without trailing blanks. A loop, because `/[ \t]+$/` is quadratic on a long blank run. */
const trimTail = (s: string) => {
	let e = s.length;
	while (e > 0 && isBlank(s[e - 1])) e--;
	return s.slice(0, e);
};

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
 * `oldEnd` to `newName`. Refuses a self-link and a link that already exists.
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
	return lines.join('\n');
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
	const out = new Map<string, number>();
	for (const l of source.split('\n')) {
		const m = inertiaComment(l);
		if (m) out.set(unquote(m[2].trim()), Number(m[4]));
	}
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

/**
 * Adds an anchor or component at [visibility, evolution], after the last top-level
 * declaration. The name must be new.
 */
export function addElement(source: string, kind: 'anchor' | 'component', name: string, visibility: number, evolution: number): string {
	const lines = source.split('\n');
	const n = name.trim();
	if (lines.some(l => nameSpans(l).some(s => s.declaration && s.name === n))) throw new EditError(`"${n}" already exists in this map.`);
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
	return out.join('\n');
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
 * Deletes an anchor or component with everything that refers to it: its links and its
 * evolve arrow. A pipeline parent is refused (its pipeline block would dangle).
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
	return withoutInertiaPosition(lines, name).join('\n');
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

/** Reads the link between `a` and `b` (either order). */
export function getLink(source: string, a: string, b: string): LinkInfo {
	const lines = source.split('\n');
	const { i, sp } = findLink(lines, a, b);
	const line = lines[i];
	const arrow = line.slice(sp[0].end, sp[1].start).trim();
	const after = line.slice(sp[1].end);
	const inline = /^\+'([^']*)'/.exec(arrow)?.[1] ?? /^\+"([^"]*)"/.exec(arrow)?.[1];
	const annotation = /^[ \t]*;(.*)$/.exec(after)?.[1].trim();
	// The direction is read from the arrow without its inline label (`+'a<b'>` is forward).
	const bare = arrow.replace(/^\+'[^']*'|^\+"[^"]*"/, '+');
	const kind: LinkKind = bare.startsWith('+')
		? (bare.includes('<>') ? 'both' : bare.includes('<') ? 'backward' : 'forward')
		: bare.includes('.') ? 'dashed' : 'line';
	return { from: sp[0].name, to: sp[1].name, kind, label: (inline ?? annotation ?? '').trim() };
}

/**
 * Rewrites the link between `a` and `b`: its kind and its label (`; label`, omitted when
 * empty). An inline flow label is folded into the `; label` form; the order of the two
 * names is kept, so "forward" keeps meaning "towards the second name".
 */
export function setLink(source: string, a: string, b: string, kind: LinkKind, label: string): string {
	const lines = source.split('\n');
	const { i, sp } = findLink(lines, a, b);
	const line = lines[i];
	const l = label.replace(/[\r\n]+/g, ' ').trim();
	const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
	lines[i] = `${indent}${line.slice(sp[0].start, sp[0].end)} ${ARROW_OF[kind]} ${line.slice(sp[1].start, sp[1].end)}${l ? `; ${l}` : ''}`;
	return lines.join('\n');
}

/** Deletes the link between `a` and `b` (its whole line, label included). */
export function unlink(source: string, a: string, b: string): string {
	const lines = source.split('\n');
	const { i } = findLink(lines, a, b);
	lines.splice(i, 1);
	return lines.join('\n');
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

/** Renames an element everywhere in the map: declaration, links, evolve, pipeline. */
export function rename(source: string, oldName: string, newName: string): string {
	const next = newName.trim();
	if (next === oldName) return source;
	const written = formatName(next);
	const lines = source.split('\n');
	findDeclaration(lines, oldName);
	if (lines.some(l => nameSpans(l).some(s => s.declaration && s.name === next))) {
		throw new EditError(`"${next}" already exists in this map.`);
	}
	return lines.map(l => {
		const pos = inertiaComment(l);
		if (pos) return unquote(pos[2].trim()) === oldName ? `${pos[1]}${written}${pos[3]}${pos[4]}` : l;
		const spans = nameSpans(l).filter(s => s.name === oldName).sort((a, b) => b.start - a.start);
		for (const s of spans) l = l.slice(0, s.start) + written + l.slice(s.end);
		return l;
	}).join('\n');
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

/**
 * Where `src` sits in `text`: the offset of the body of the one fenced ```mermaid block whose
 * body is exactly `src`, or why it cannot be edited there. Only a block of its own counts: a
 * map in a callout, list or quote is drawn from text with a prefix on every line, and a plain
 * search would find (and overwrite) the same text elsewhere, e.g. in a code example (review F3).
 */
export function locateBlock(text: string, src: string): number | string {
	const lines = text.split('\n');
	const starts: number[] = [];
	let offset = 0;
	for (const l of lines) { starts.push(offset); offset += l.length + 1; }
	const hits: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = /^(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		if (!open) continue;
		const fence = open[1];
		let close = i + 1;
		while (close < lines.length && !isClosingFence(lines[close], fence)) close++;
		if (/^mermaid(?:[ \t]|$)/.test(open[2].trim()) && i + 1 <= lines.length - 1) {
			const from = starts[i + 1];
			const body = close < lines.length ? text.slice(from, Math.max(from, starts[close] - 1)) : text.slice(from);
			if (body === src) hits.push(from);
		}
		i = close;
	}
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) return 'This map occurs more than once in the note, edit it in the source.';
	if (text.includes(src)) return 'Only a map in a ```mermaid block of its own can be edited here (not in a callout, list or quote), edit it in the source.';
	return 'The map changed in the meantime, nothing was written.';
}

const isClosingFence = (line: string, fence: string) => {
	const t = trimTail(line);
	return t.length >= fence.length && t[0] === fence[0] && [...t].every(c => c === fence[0]);
};

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
 * else near the middle, at least 0.08 away from every positioned element (notes and
 * (de)accelerators included).
 */
export function freeSpot(source: string, kind: 'anchor' | 'component' | 'note'): { visibility: number; evolution: number } {
	const taken: { visibility: number; evolution: number }[] = [];
	for (const p of declaredPositions(source)) if (p.visibility !== undefined) taken.push({ visibility: p.visibility, evolution: p.evolution });
	for (const l of source.split('\n')) {
		const m = /^[ \t]*(?:note|accelerator|deaccelerator)\b.*\[[ \t]*([-\d.]+)[ \t]*,[ \t]*([-\d.]+)[ \t]*\][ \t]*$/.exec(l);
		if (m) taken.push({ visibility: Number(m[1]), evolution: Number(m[2]) });
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
