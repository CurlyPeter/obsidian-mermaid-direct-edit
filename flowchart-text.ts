/**
 * Pure text edits on a Mermaid flowchart source. No DOM, no Obsidian: every function takes the
 * block's source and returns the new source or throws an `EditError` whose message is shown to
 * the user. The caller validates the result with `mermaid.parse()` before writing it.
 *
 * Edits change as little as possible (decision A3, 2026-10-11): a label, an arrow, a name. Only
 * an edit that has to split a chain or an `&` group rewrites that one statement, keeping the edge
 * order (so `linkStyle` numbers stay right), every node, its shape and its subgraph. Edge numbers
 * that do shift (an edge deleted or inserted before others) are carried into `linkStyle`.
 *
 * Every edit returns through `checked` (flowchart-meaning.ts): the result has to mean what the
 * source meant, changed exactly as the edit intends, or it is refused.
 */
import { EditError, MAX_LINE, MAX_SOURCE } from './blocks';
import { Meaning, checked, edgeKey, edgeKeyOf, metaField, rekey, retitle, swap } from './flowchart-meaning';
import { Arrow, Chain, Edge, Flow, Label, NodeRef, Other, SHAPES, ScanError, ShapeType, Subgraph, isInside, scan, scanCached } from './flowchart-scan';

export { EditError };

/** A change of the source: replace [start, end) with `text`. */
interface Splice { start: number; end: number; text: string }

function applySplices(src: string, splices: Splice[]): string {
	// Deletions that touch or overlap (two removed lines next to each other) become one.
	const asc = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Splice[] = [];
	for (const s of asc) {
		const prev = merged[merged.length - 1];
		if (prev && s.start < prev.end) {
			if (prev.text || s.text) throw new EditError('Overlapping changes, nothing was changed.');
			prev.end = Math.max(prev.end, s.end);
			continue;
		}
		merged.push({ ...s });
	}
	let out = src;
	for (const s of merged.reverse()) out = out.slice(0, s.start) + s.text + out.slice(s.end);
	return out;
}

/** Scans `src`, reporting what the scanner does not understand as an edit error. */
export function read(src: string): Flow {
	try {
		return scanCached(src);
	} catch (e) {
		if (e instanceof ScanError) throw new EditError(`This flowchart uses syntax the editor does not know yet (${e.message}) Edit it in the source.`);
		throw e;
	}
}

/**
 * Why a rendered flowchart is not editable graphically, or null when it is. Such a flowchart still
 * renders; it is just not tagged for the editor.
 */
export function flowchartBlocker(src: string): string | null {
	if (src.length > MAX_SOURCE) return 'This flowchart is too large to edit graphically, edit it in the source.';
	if (src.split('\n').some(l => l.length > MAX_LINE)) return 'A line of this flowchart is too long to edit graphically, edit it in the source.';
	try {
		scanCached(src);
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	return null;
}

// ---- writing labels and arrows -----------------------------------------------------------

/** Text Mermaid reads unquoted inside brackets and pipes: no brackets, pipes, quotes, slashes, `;`, `@`. */
const SAFE = /^[\p{L}\p{N} .,:!?'+*#&%$=~^_-]*$/u;
/** Text that may stay an inline edge label (`-- text -->`): nothing that could close the arrow. */
const INLINE_SAFE = /^[\p{L}\p{N} ,:!?'+*#&%$_]*$/u;

function cleanText(text: string, what: string): string {
	const t = text.trim();
	if (!t) throw new EditError(`The ${what} must not be empty.`);
	if (/[\r\n]/.test(t)) throw new EditError(`The ${what} must be a single line (use <br> for a line break).`);
	// Mermaid's lexer reads a whole line containing this as a direction statement, quotes or not.
	if (/direction\s+(TB|BT|RL|LR|TD)/.test(t)) throw new EditError(`Mermaid reads "direction" followed by TB, BT, LR, RL or TD anywhere in a line as a direction, write the ${what} differently (for example "direction: LR").`);
	return t.replace(/"/g, '#quot;');
}

/** A label as written inside a shape or pipes: bare when safe and it was bare, else quoted. */
export function labelText(text: string, was: Label | null, what = 'label'): string {
	const t = cleanText(text, what);
	if (was?.markdown) return `"\`${t}\`"`;
	if (!was?.quoted && SAFE.test(t) && !t.includes('#quot;')) return t;
	return `"${t}"`;
}

const HEAD_END: Record<Arrow['head'], string> = { none: '', arrow: '>', circle: 'o', cross: 'x' };
const HEAD_START: Record<Arrow['head'], string> = { none: '', arrow: '<', circle: 'o', cross: 'x' };

/** The link token for an arrow, as one token (`-->`, `o-.-o`, `===`, `~~~`). */
export function arrowText(a: Arrow): string {
	const len = Math.max(1, Math.min(10, Math.round(a.length)));
	if (a.stroke === 'invisible') return '~'.repeat(len + 2);
	const start = a.both ? HEAD_START[a.head] : '';
	const end = HEAD_END[a.head];
	if (a.stroke === 'dotted') return `${start}-${'.'.repeat(len)}-${end}`;
	const c = a.stroke === 'thick' ? '=' : '-';
	return `${start}${c.repeat(len + 1)}${end || c}`;
}

/** The arrow with an inline label: `-- text -->`, `== text ==>`, `-. text .->`. */
function inlineText(a: Arrow, text: string): string {
	const len = Math.max(1, Math.min(10, Math.round(a.length)));
	const start = a.both ? HEAD_START[a.head] : '';
	const end = HEAD_END[a.head];
	if (a.stroke === 'dotted') return `${start}-. ${text} ${'.'.repeat(len)}-${end}`;
	const c = a.stroke === 'thick' ? '=' : '-';
	return `${start}${c}${c} ${text} ${c.repeat(len + 1)}${end || c}`;
}

/** The plain arrow `-->` new links get. */
const POINT: Arrow = { stroke: 'normal', head: 'arrow', both: false, length: 1 };

const sameArrow = (a: Arrow, b: Arrow) => a.stroke === b.stroke && a.head === b.head && a.both === b.both && a.length === b.length;

// ---- reading what the dialogs show ---------------------------------------------------------

export interface NodeInfo {
	id: string;
	label: string;
	/** The bracket shape that wins (Mermaid keeps the last), or null for the default rectangle. */
	shape: ShapeType | null;
	/** The node uses the `@{ shape: … }` syntax; its value. */
	meta: string | null;
	group: Subgraph | null;
	/** `fill` of a `style <id>` statement, if any. */
	fill: string | null;
}

export function nodeInfo(src: string, id: string): NodeInfo {
	const flow = read(src);
	const mentions = flow.nodes.get(id);
	if (!mentions) throw new EditError(`"${id}" is not in this flowchart.`);
	let label = id, shape: ShapeType | null = null, meta: string | null = null;
	for (const n of mentions) {
		if (n.shape) { label = n.shape.label.text; shape = n.shape.type; }
		if (n.meta) {
			const m = metaValue(n.meta.body, 'shape');
			if (m) meta = m.value;
			const l = metaValue(n.meta.body, 'label');
			if (l) label = l.value;
		}
	}
	return { id, label, shape, meta, group: flow.memberOf.get(id) ?? null, fill: styleProps(flow, id).get('fill') ?? null };
}

export interface EdgeInfo { index: number; from: string; to: string; arrow: Arrow; label: string }

export function edgeInfo(src: string, index: number): EdgeInfo {
	const flow = read(src);
	const e = edgeAt(flow, index);
	const link = e.chain.links[e.link];
	return { index, from: e.from.id, to: e.to.id, arrow: { ...link.arrow }, label: link.label?.label.text ?? '' };
}

function edgeAt(flow: Flow, index: number): Edge {
	const e = flow.edges[index];
	if (!e) throw new EditError('This edge changed in the meantime, nothing was written.');
	return e;
}

/** The index of the edge Mermaid drew with this `data-id`, or -1. */
export function edgeIndexOf(flow: Flow, id: string): number {
	return flow.edges.findIndex(e => e.id === id);
}

// ---- statements: rewriting one chain -----------------------------------------------------

interface Planned {
	edge: Edge;
	from: NodeRef;
	to: NodeRef;
	/** Replacement for the link text (arrow and label); undefined keeps it. */
	link?: string;
}

/** The text of a link for one of its edges: a user id stays only with the edge it names. */
function linkTextFor(flow: Flow, p: Planned): string {
	const link = p.edge.chain.links[p.edge.link];
	const body = p.link ?? flow.src.slice(link.id ? link.id.end : link.start, link.end);
	return link.id && link.id.name === p.edge.id ? `${flow.src.slice(link.id.start, link.id.end)}${body}` : body;
}

/** Indentation of the line `at` lies on. */
function indentAt(src: string, at: number): string {
	const ls = src.lastIndexOf('\n', at - 1) + 1;
	return /^[ \t]*/.exec(src.slice(ls, at + 1))?.[0] ?? '';
}

/** A chain, a subgraph block or another statement, as a span of the source. */
type Stmt = { start: number; end: number };

/** Removes a statement: its whole line when it stands alone, else the statement and one `;`. */
function removal(src: string, st: Stmt): Splice {
	const ls = src.lastIndexOf('\n', st.start - 1) + 1;
	let le = src.indexOf('\n', st.end);
	if (le < 0) le = src.length;
	const before = src.slice(ls, st.start), after = src.slice(st.end, le);
	if (!before.trim() && !after.trim()) {
		// The line with its line break (the previous one at the end of the source).
		return le < src.length ? { start: ls, end: le + 1, text: '' } : { start: Math.max(0, ls - 1), end: le, text: '' };
	}
	const semi = /^[ \t]*;[ \t]*/.exec(after);
	if (semi) return { start: st.start, end: st.end + semi[0].length, text: '' };
	// A `;` before it (index scan: a regex anchored at the end would retry from every blank).
	let p = before.length;
	while (p > 0 && (before[p - 1] === ' ' || before[p - 1] === '\t')) p--;
	if (before[p - 1] === ';') {
		p--;
		while (p > 0 && (before[p - 1] === ' ' || before[p - 1] === '\t')) p--;
		return { start: ls + p, end: st.end, text: '' };
	}
	return { start: st.start, end: st.end, text: '' };
}

/**
 * Whether node `id`, losing its mention in `chain`, must keep a bare mention there: it carries its
 * shape, label or class there, it is mentioned nowhere else, or that mention is what puts it into
 * the chain's subgraph.
 */
function keepsMention(flow: Flow, chain: Chain, id: string): boolean {
	const here = chain.groups.flat().filter(n => n.id === id);
	if (here.some(n => n.shape || n.meta || n.cls)) return true;
	const elsewhere = (flow.nodes.get(id) ?? []).filter(n => !here.includes(n));
	if (!elsewhere.length) return true;
	const sg = chain.parent;
	if (!sg || flow.memberOf.get(id) !== sg) return false;
	return !sg.members.some(m => m !== chain && m.kind === 'chain' && m.groups.some(g => g.some(n => n.id === id)));
}

/**
 * The chain rewritten with `edges` (in Mermaid's order): consecutive edges continue the line
 * (`A --> B --> C`), a node's definition travels with its first mention, and nodes that lose
 * every edge keep a bare mention where they need one. `drop` names nodes being deleted.
 */
function rewriteChain(flow: Flow, chain: Chain, edges: Planned[], drop: Set<string> = new Set()): Splice {
	const src = flow.src;
	const defs = new Map<string, string>();
	for (const n of chain.groups.flat()) if (n.shape || n.meta || n.cls) defs.set(n.id, src.slice(n.start, n.end));
	const emitted = new Set<string>();
	const text = (n: NodeRef) => {
		if (emitted.has(n.id)) return n.id;
		emitted.add(n.id);
		return defs.get(n.id) ?? n.id;
	};
	// Each line remembers where its first node stood, so the order of the statement survives.
	const keep = new Set<string>();
	for (const n of chain.groups.flat()) {
		if (!drop.has(n.id) && !edges.some(p => p.from.id === n.id || p.to.id === n.id) && keepsMention(flow, chain, n.id)) keep.add(n.id);
	}
	const items: { at: number; node?: NodeRef; edges?: Planned[] }[] = [];
	const placed = new Set<string>();
	for (const n of chain.groups.flat()) {
		if (keep.has(n.id) && !placed.has(n.id)) { placed.add(n.id); items.push({ at: n.start, node: n }); }
	}
	let run: Planned[] = [];
	for (const p of edges) {
		if (run.length && run[run.length - 1].to.id === p.from.id) run.push(p);
		else { if (run.length) items.push({ at: run[0].edge.from.start, edges: run }); run = [p]; }
	}
	if (run.length) items.push({ at: run[0].edge.from.start, edges: run });
	// Stable: a kept node goes before an edge line that starts where it stood.
	items.sort((a, b) => a.at - b.at || (a.node ? -1 : 0) - (b.node ? -1 : 0));
	const lines = items.map(it => it.node
		? text(it.node)
		: it.edges!.reduce((line, p, i) => `${line}${i ? '' : text(p.from)} ${linkTextFor(flow, p)} ${text(p.to)}`, ''));
	if (!lines.length) return removal(src, chain);
	return { start: chain.start, end: chain.end, text: lines.join(`\n${indentAt(src, chain.start)}`) };
}

/** The chain's edges, in order, as plans to rewrite it with. */
const plansOf = (flow: Flow, chain: Chain): Planned[] =>
	flow.edges.filter(e => e.chain === chain).map(edge => ({ edge, from: edge.from, to: edge.to }));

/** Whether a link stands for exactly one edge (both its groups are single nodes). */
const single = (e: Edge) => e.chain.groups[e.link].length === 1 && e.chain.groups[e.link + 1].length === 1;

// ---- linkStyle numbers -----------------------------------------------------------------------

/**
 * `linkStyle` statements renumbered after edges were removed (old indices) or inserted (count,
 * before the old index `before`). A statement left with no edge is removed.
 */
function remapLinkStyles(flow: Flow, removed: Set<number>, inserted: { before: number; count: number }[] = []): Splice[] {
	return renumberLinkStyles(flow, n => {
		if (removed.has(n)) return null;
		let shift = 0;
		for (const r of removed) if (r < n) shift--;
		for (const ins of inserted) if (ins.before <= n) shift += ins.count;
		return n + shift;
	});
}

/** `linkStyle` statements with every index passed through `map` (null: that edge is gone). */
function renumberLinkStyles(flow: Flow, map: (old: number) => number | null): Splice[] {
	const out: Splice[] = [];
	for (const o of flow.others) {
		if (o.kind !== 'linkStyle' || o.arg === 'default') continue;
		const old = o.arg.split(',').map(x => Number(x.trim()));
		if (old.some(n => !Number.isInteger(n))) continue;
		const next = old.map(map).filter((n): n is number => n !== null);
		if (next.join(',') === old.join(',')) continue;
		out.push(next.length ? { start: o.argStart, end: o.argEnd, text: next.join(',') } : removal(flow.src, o));
	}
	return out;
}

// ---- edges -----------------------------------------------------------------------------------

/**
 * Sets an edge's look and label (empty: none). Unchanged parts keep their text; an inline label
 * stays inline while that is safe, otherwise it becomes `|label|`.
 */
export function setEdge(src: string, index: number, arrow: Arrow, label: string): string {
	const flow = read(src);
	const e = edgeAt(flow, index);
	const link = e.chain.links[e.link];
	const text = label.trim() ? cleanText(label, 'label') : '';
	const old = link.label?.label ?? null;
	if (sameArrow(arrow, link.arrow) && text === (old ? cleanText(old.text, 'label') : '')) return src;
	const expect = (m: Meaning) => rekey(m, edgeKey(e), edgeKeyOf(e.from.id, e.to.id, arrow, text, userId(e)));
	let body: string;
	if (text && link.label?.form === 'inline' && INLINE_SAFE.test(text) && arrow.stroke !== 'invisible') {
		if (sameArrow(arrow, link.arrow)) {
			// Only the words change: keep the arrow as written, with a blank on either side, or the
			// words run into it (`--offer -->` reads as a circle end, code review 0.18.0).
			const l = link.label.label;
			const pre = isBlank(src[l.start - 1]) ? '' : ' ', post = isBlank(src[l.end]) ? '' : ' ';
			return checked(src, applySplices(src, [{ start: l.start, end: l.end, text: `${pre}${l.quoted ? `"${text}"` : text}${post}` }]), expect);
		}
		body = inlineText(arrow, text);
	} else {
		const arrowPart = sameArrow(arrow, link.arrow) && link.label?.form !== 'inline' ? src.slice(link.arrowStart, link.arrowEnd) : arrowText(arrow);
		body = text ? `${arrowPart}|${labelText(text, link.label?.form === 'pipe' ? old : null)}|` : arrowPart;
	}
	if (single(e)) return checked(src, applySplices(src, [{ start: link.id ? link.id.end : link.start, end: link.end, text: body }]), expect);
	const plans = plansOf(flow, e.chain).map(p => (p.edge === e ? { ...p, link: body } : p));
	return checked(src, applySplices(src, [rewriteChain(flow, e.chain, plans)]), expect);
}

const isBlank = (c: string | undefined) => c === ' ' || c === '\t';
/** The edge's own id when it was written (`e1@-->`), else null. */
const userId = (e: Edge) => { const l = e.chain.links[e.link]; return l.id && l.id.name === e.id ? e.id : null; };

/** Turns an edge around: `A --> B` becomes `B --> A` (each node keeps its shape and label). */
export function reverseEdge(src: string, index: number): string {
	const flow = read(src);
	const e = edgeAt(flow, index);
	if (e.from.id === e.to.id) return src;
	const link = e.chain.links[e.link];
	const expect = (m: Meaning) => rekey(m, edgeKey(e), edgeKeyOf(e.to.id, e.from.id, link.arrow, link.label?.label.text ?? '', userId(e)));
	if (e.chain.links.length === 1 && single(e)) {
		return checked(src, applySplices(src, [
			{ start: e.from.start, end: e.from.end, text: src.slice(e.to.start, e.to.end) },
			{ start: e.to.start, end: e.to.end, text: src.slice(e.from.start, e.from.end) },
		]), expect);
	}
	const plans = plansOf(flow, e.chain).map(p => (p.edge === e ? { ...p, from: e.to, to: e.from } : p));
	return checked(src, applySplices(src, [rewriteChain(flow, e.chain, plans)]), expect);
}

/** Deletes an edge; its nodes stay, with their shapes and subgraphs. */
export function deleteEdge(src: string, index: number): string {
	const flow = read(src);
	const e = edgeAt(flow, index);
	const plans = plansOf(flow, e.chain).filter(p => p.edge !== e);
	return checked(src, applySplices(src, [rewriteChain(flow, e.chain, plans), ...remapLinkStyles(flow, new Set([index]))]), m => rekey(m, edgeKey(e), null));
}

/**
 * Moves one end of an edge to another node: `A --> B` becomes `A --> C`. Rewritten where it
 * stands when that keeps every node in its group; otherwise (the statement sits in a group the new
 * node is not in, code review 0.18.0) the edge moves behind all others at the top level.
 */
export function relinkEdge(src: string, index: number, end: 'from' | 'to', id: string): string {
	const flow = read(src);
	const e = edgeAt(flow, index);
	if (!flow.nodes.has(id) && !flow.subgraphs.some(s => s.id === id)) throw new EditError(`"${id}" is not in this flowchart.`);
	if ((end === 'from' ? e.from.id : e.to.id) === id) return src;
	const other = end === 'from' ? e.to.id : e.from.id;
	if (other === id) throw new EditError('A link cannot start and end at the same node here.');
	const link = e.chain.links[e.link];
	const from = end === 'from' ? id : e.from.id, to = end === 'to' ? id : e.to.id;
	const expect = (m: Meaning) => rekey(m, edgeKey(e), edgeKeyOf(from, to, link.arrow, link.label?.label.text ?? '', userId(e)));
	const target: NodeRef = { id, start: -1, end: -1, idEnd: -1, shape: null, meta: null, cls: null };
	const inPlace = plansOf(flow, e.chain).map(p => (p.edge === e ? { ...p, [end]: target } : p));
	try {
		return checked(src, applySplices(src, [rewriteChain(flow, e.chain, inPlace)]), expect);
	} catch (err) {
		if (!(err instanceof EditError) || !e.chain.parent) throw err;
	}
	const rest = plansOf(flow, e.chain).filter(p => p.edge !== e);
	const moved = `${from} ${linkTextFor(flow, { edge: e, from: e.from, to: e.to })} ${to}`;
	const last = flow.edges.length - 1;
	return checked(src, applySplices(src, [
		rewriteChain(flow, e.chain, rest),
		insertAfter(flow, afterEdges(flow), [moved]),
		...renumberLinkStyles(flow, n => (n === index ? last : n > index ? n - 1 : n)),
	]), expect);
}

/** Adds `from --> to` after the last edge, so no edge number (and no `linkStyle`) shifts. */
export function addEdge(src: string, from: string, to: string): string {
	const flow = read(src);
	for (const id of [from, to]) if (!flow.nodes.has(id) && !flow.subgraphs.some(s => s.id === id)) throw new EditError(`"${id}" is not in this flowchart.`);
	if (from === to) throw new EditError('A node cannot be linked to itself here.');
	if (flow.edges.some(e => e.from.id === from && e.to.id === to)) throw new EditError(`"${from}" is already linked to "${to}".`);
	return checked(src, applySplices(src, [insertAfter(flow, afterEdges(flow), [`${from} --> ${to}`])]), m => swap(m.edges, null, edgeKeyOf(from, to, POINT, '', null)));
}

/**
 * Where a new top-level statement goes so that it comes after every edge: after the last statement
 * holding one (a subgraph block counts as a whole), else after the last node, else the header.
 */
function afterEdges(flow: Flow): Stmt | null {
	let anchor: Stmt | null = null;
	for (const st of flow.statements) {
		const hasEdge = st.kind === 'chain' ? st.links.length > 0 : st.kind === 'subgraph' && flow.chains.some(c => c.links.length && isInside(c, st));
		if (hasEdge) anchor = span(st);
	}
	return anchor ?? afterNodes(flow);
}

/** After the last top-level node statement or subgraph block, or null (the header). */
function afterNodes(flow: Flow, except?: Subgraph): Stmt | null {
	const last = [...flow.statements].reverse().find(st => (st.kind === 'chain' || st.kind === 'subgraph') && st !== except);
	return last ? span(last) : null;
}

/** A statement's span; a subgraph's covers its whole block. */
const span = (st: Chain | Subgraph | Other): Stmt => (st.kind === 'subgraph' ? { start: st.start, end: st.endEnd } : st);

/**
 * Inserts `lines` as statements on new lines right after `anchor` (null: after the header). Not
 * after the rest of its line: a `; subgraph S` there would take the new lines into S (code review
 * 0.18.0). What followed on that line moves to a line of its own after them.
 */
function insertAfter(flow: Flow, anchor: Stmt | null, lines: string[]): Splice {
	const src = flow.src;
	const at = anchor ? anchor.end : flow.header.end;
	const indent = anchor ? indentAt(src, anchor.start) : firstIndent(flow);
	let i = at;
	while (isBlank(src[i])) i++;
	const more = src[i] === ';' ? i + 1 : -1;
	if (more < 0) return { start: at, end: at, text: lines.map(l => `\n${indent}${l}`).join('') };
	let j = more;
	while (isBlank(src[j])) j++;
	const tail = j < src.length && src[j] !== '\n' ? `\n${indent}` : '';
	return { start: at, end: j, text: lines.map(l => `\n${indent}${l}`).join('') + tail };
}

/** Indentation of the first statement after the header, or two blanks. */
function firstIndent(flow: Flow): string {
	const first = [...flow.statements].sort((a, b) => a.start - b.start)[0];
	return first ? indentAt(flow.src, first.start) : '  ';
}

/** Indentation of a statement directly inside `sg`. */
function memberIndent(src: string, sg: Subgraph): string {
	const first = sg.members[0];
	return first ? indentAt(src, first.start) : `${indentAt(src, sg.start)}  `;
}

/** Inserts `lines` as the last statements of `sg`'s block, before its `end`. */
function insertInto(src: string, sg: Subgraph, lines: string[]): Splice {
	const ls = src.lastIndexOf('\n', sg.endStart - 1) + 1;
	if (src.slice(ls, sg.endStart).trim()) return { start: sg.endStart, end: sg.endStart, text: `${lines.join('; ')}; ` };
	const indent = memberIndent(src, sg);
	return { start: ls, end: ls, text: lines.map(l => `${indent}${l}\n`).join('') };
}

// ---- nodes -----------------------------------------------------------------------------------

/** `key: value` in a `@{ … }` body: its value and where the value sits in the body. */
function metaValue(body: string, key: string): { value: string; start: number; end: number } | null {
	const m = new RegExp(`(?:^|[\\s,{])${key}[ \\t]*:[ \\t]*`).exec(body);
	if (!m) return null;
	const at = m.index + m[0].length;
	if (body[at] === '"') {
		const close = body.indexOf('"', at + 1);
		if (close < 0) return null;
		return { value: body.slice(at + 1, close), start: at, end: close + 1 };
	}
	let end = at;
	while (end < body.length && body[end] !== ',' && body[end] !== '\n' && body[end] !== '}') end++;
	return { value: body.slice(at, end).trim(), start: at, end: at + body.slice(at, end).trimEnd().length };
}

/** A `@{ … }` body with `key` set to `value` (written as given). */
function setMeta(body: string, key: string, value: string): string {
	const v = metaValue(body, key);
	if (v) return body.slice(0, v.start) + value + body.slice(v.end);
	const trimmed = body.trimEnd();
	if (trimmed.includes('\n')) {
		const indent = /\n([ \t]*)\S/.exec(body)?.[1] ?? '  ';
		return `${trimmed}\n${indent}${key}: ${value}${body.slice(trimmed.length)}`;
	}
	return `${trimmed}${trimmed.trim() ? ',' : ''} ${key}: ${value}${body.slice(trimmed.length) || ' '}`;
}

function mentionsOf(flow: Flow, id: string): NodeRef[] {
	const m = flow.nodes.get(id);
	if (!m) throw new EditError(`"${id}" is not in this flowchart.`);
	return m;
}

/** Sets a node's label wherever it is defined (or on its first mention, as a rectangle). */
export function setNodeLabel(src: string, id: string, label: string): string {
	const flow = read(src);
	const mentions = mentionsOf(flow, id);
	const splices: Splice[] = [];
	for (const n of mentions) {
		if (n.shape) splices.push({ start: n.shape.label.start, end: n.shape.label.end, text: labelText(label, n.shape.label) });
		if (n.meta) {
			const body = setMeta(n.meta.body, 'label', `"${cleanText(label, 'label')}"`);
			splices.push({ start: n.meta.start + 2, end: n.meta.end - 1, text: body });
		}
	}
	if (!splices.length) {
		const first = mentions[0];
		if (!first) throw new EditError(`"${id}" has no mention to put a label on.`);
		splices.push({ start: first.idEnd, end: first.idEnd, text: `[${labelText(label, null)}]` });
	}
	const text = cleanText(label, 'label');
	return checked(src, applySplices(src, splices), m => {
		m.label.set(id, text);
		if (!mentions.some(n => n.shape || n.meta)) m.shape.set(id, 'square');
	});
}

/** New-syntax names (`@{ shape: … }`) of the classic shapes, for nodes written that way. */
export const META_SHAPE: Record<ShapeType, string> = {
	square: 'rect', round: 'rounded', stadium: 'stadium', subroutine: 'subproc', cylinder: 'cyl', circle: 'circle',
	doublecircle: 'dbl-circ', ellipse: 'ellipse', diamond: 'diam', hexagon: 'hex', odd: 'odd',
	lean_right: 'lean-r', lean_left: 'lean-l', trapezoid: 'trap-b', inv_trapezoid: 'trap-t',
};

/** Sets a node's shape wherever it is defined (or on its first mention, labelled with its id). */
export function setNodeShape(src: string, id: string, type: ShapeType): string {
	const flow = read(src);
	const mentions = mentionsOf(flow, id);
	const sh = SHAPES.find(s => s.type === type);
	if (!sh) throw new EditError(`Unknown shape "${type}".`);
	const splices: Splice[] = [];
	for (const n of mentions) {
		if (n.shape) {
			// The label as written; a bare one that the new brackets would misread gets quotes.
			const l = n.shape.label;
			const inner = l.quoted || SAFE.test(l.text) ? src.slice(l.start, l.end) : `"${l.text.replace(/"/g, '#quot;')}"`;
			splices.push({ start: n.shape.start, end: n.shape.end, text: `${sh.open}${inner}${sh.close}` });
		}
		if (n.meta) splices.push({ start: n.meta.start + 2, end: n.meta.end - 1, text: setMeta(n.meta.body, 'shape', META_SHAPE[type]) });
	}
	if (!splices.length) {
		const first = mentions[0];
		if (!first) throw new EditError(`"${id}" has no mention to put a shape on.`);
		splices.push({ start: first.idEnd, end: first.idEnd, text: `${sh.open}${labelText(id, null)}${sh.close}` });
	}
	// The definition that wins decides how the new shape is named (`@{ shape }` or brackets).
	const last = [...mentions].reverse().find(n => n.shape || n.meta);
	return checked(src, applySplices(src, splices), m => m.shape.set(id, last?.meta ? META_SHAPE[type] : type));
}

/**
 * Deletes a node with every edge at it, its `style`, `click` and `class` entries. The other nodes
 * of its statements stay, with their shapes and subgraphs; `linkStyle` numbers follow.
 */
export function deleteNode(src: string, id: string): string {
	const flow = read(src);
	mentionsOf(flow, id);
	if (flow.subgraphs.some(s => s.id === id)) throw new EditError(`"${id}" is a subgraph, delete it from its title.`);
	const splices: Splice[] = [];
	const removed = new Set<number>();
	for (const chain of flow.chains) {
		if (!chain.groups.some(g => g.some(n => n.id === id))) continue;
		const plans = plansOf(flow, chain).filter(p => {
			const gone = p.from.id === id || p.to.id === id;
			if (gone) removed.add(p.edge.index);
			return !gone;
		});
		splices.push(rewriteChain(flow, chain, plans, new Set([id])));
	}
	for (const o of flow.others) {
		if ((o.kind === 'style' || o.kind === 'click') && o.arg === id) splices.push(removal(src, o));
		if (o.kind === 'class') {
			const ids = o.arg.split(',').map(x => x.trim());
			if (!ids.includes(id)) continue;
			const rest = ids.filter(x => x !== id);
			splices.push(rest.length ? { start: o.argStart, end: o.argEnd, text: rest.join(',') } : removal(src, o));
		}
	}
	return checked(src, applySplices(src, [...splices, ...remapLinkStyles(flow, removed)]), m => {
		forget(m, id);
		for (const e of flow.edges) if (removed.has(e.index)) rekey(m, edgeKey(e), null);
	});
}

/** A node leaves the meaning (it is deleted). */
function forget(m: Meaning, id: string) {
	m.label.delete(id);
	m.shape.delete(id);
	m.group.delete(id);
}

// ---- adding nodes ----------------------------------------------------------------------------

const RESERVED = /^(end|subgraph|graph|flowchart|style|classDef|class|linkStyle|click|direction|default|call|href|interpolate|accTitle|accDescr)$/;

/** A readable, unused id from a label: "Check stock" → `CheckStock`. */
export function newId(flow: Flow, label: string): string {
	const folded = label.normalize('NFKD').replace(/ß/g, 'ss').replace(/[̀-ͯ]/g, m => (m === '̈' ? 'e' : ''));
	const words = folded.split(/[^A-Za-z0-9]+/).filter(Boolean);
	let base = words.map(w => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 24);
	if (!base) base = 'Node';
	if (/^[0-9]/.test(base)) base = `N${base}`;
	if (RESERVED.test(base)) base = `${base}Node`;
	const taken = new Set([...flow.nodes.keys(), ...flow.subgraphs.map(s => s.id)]);
	let id = base;
	for (let i = 2; taken.has(id); i++) id = `${base}${i}`;
	return id;
}

function shapeText(type: ShapeType, label: string): string {
	const sh = SHAPES.find(s => s.type === type);
	if (!sh) throw new EditError(`Unknown shape "${type}".`);
	return `${sh.open}${labelText(label, null)}${sh.close}`;
}

/** Adds a node on its own, after the last statement at the top level. */
export function addNode(src: string, label: string, type: ShapeType = 'square'): string {
	const flow = read(src);
	const id = newId(flow, label);
	const text = cleanText(label, 'label');
	return checked(src, applySplices(src, [insertAfter(flow, afterNodes(flow), [`${id}${shapeText(type, label)}`])]), m => {
		m.label.set(id, text);
		m.shape.set(id, type);
		m.group.set(id, '');
	});
}

/**
 * Adds a node linked from `from`: `from --> NewNode[Label]`. When `from` belongs to a subgraph, the
 * new statement goes into that subgraph, so the new node joins it; edges after it shift by one
 * and `linkStyle` follows.
 */
export function addLinkedNode(src: string, from: string, label: string, type: ShapeType = 'square'): string {
	const flow = read(src);
	if (!flow.nodes.has(from) && !flow.subgraphs.some(s => s.id === from)) throw new EditError(`"${from}" is not in this flowchart.`);
	const id = newId(flow, label);
	const text = `${from} --> ${id}${shapeText(type, label)}`;
	const sg = flow.memberOf.get(from);
	const expect = (m: Meaning) => {
		m.label.set(id, cleanText(label, 'label'));
		m.shape.set(id, type);
		m.group.set(id, sg?.title ?? '');
		swap(m.edges, null, edgeKeyOf(from, id, POINT, '', null));
	};
	if (!sg) return checked(src, applySplices(src, [insertAfter(flow, afterEdges(flow), [text])]), expect);
	const before = flow.edges.filter(e => e.chain.start < sg.endStart).length;
	return checked(src, applySplices(src, [insertInto(src, sg, [text]), ...remapLinkStyles(flow, new Set(), [{ before, count: 1 }])]), expect);
}

// ---- the diagram -----------------------------------------------------------------------------

export type Direction = 'TB' | 'TD' | 'BT' | 'LR' | 'RL';

export function getDirection(src: string): Direction {
	const d = read(src).header.dir?.value;
	return d === 'TD' || d === 'BT' || d === 'LR' || d === 'RL' ? d : 'TB';
}

/** Sets the direction in the header (`flowchart TD` → `flowchart LR`). */
export function setDirection(src: string, dir: Direction): string {
	const flow = read(src);
	const h = flow.header;
	if (h.dir) return h.dir.value === dir ? src : checked(src, applySplices(src, [{ start: h.dir.start, end: h.dir.end, text: dir }]), () => {});
	return checked(src, applySplices(src, [{ start: h.end, end: h.end, text: ` ${dir}` }]), () => {});
}

// ---- styles ----------------------------------------------------------------------------------

/** The css properties of every `style <id>` statement, later ones winning. */
function styleProps(flow: Flow, id: string): Map<string, string> {
	const props = new Map<string, string>();
	for (const o of flow.others) {
		if (o.kind !== 'style' || o.arg !== id) continue;
		for (const part of flow.src.slice(o.argEnd, o.end).split(',')) {
			const i = part.indexOf(':');
			if (i > 0) props.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
		}
	}
	return props;
}

/** A node colour: fill, outline and a text colour readable on it. */
export interface NodeColor { fill: string; stroke: string; color: string }

/**
 * Sets (or with null removes) a node's colour: `fill`, `stroke` and `color` in its `style`
 * statement; other properties there stay. A new statement goes to the end.
 */
export function setNodeColor(src: string, id: string, c: NodeColor | null): string {
	const flow = read(src);
	mentionsOf(flow, id);
	const own = flow.others.filter(o => o.kind === 'style' && o.arg === id);
	const keys = ['fill', 'stroke', 'color'];
	if (!own.length) {
		if (!c) return src;
		const end = flow.statements[flow.statements.length - 1];
		return checked(src, applySplices(src, [insertAfter(flow, end ? span(end) : null, [`style ${id} fill:${c.fill},stroke:${c.stroke},color:${c.color}`])]), () => {});
	}
	const splices: Splice[] = [];
	own.forEach((o, i) => {
		const kept = flow.src.slice(o.argEnd, o.end).split(',').map(p => p.trim()).filter(p => p && !keys.includes(p.slice(0, p.indexOf(':')).trim()));
		const props = i === own.length - 1 && c ? [`fill:${c.fill}`, `stroke:${c.stroke}`, `color:${c.color}`, ...kept] : kept;
		splices.push(props.length ? { start: o.argEnd, end: o.end, text: ` ${props.join(',')}` } : removal(flow.src, o));
	});
	return checked(src, applySplices(src, splices), () => {});
}

// ---- groups (subgraphs) ------------------------------------------------------------------------

function groupOf(flow: Flow, id: string): Subgraph {
	const sg = flow.subgraphs.find(x => x.id === id);
	if (!sg) throw new EditError(`The group "${id}" is not in this flowchart.`);
	return sg;
}

/** A statement that only mentions one node (`A`, `A[Label]`). */
const isMention = (c: Chain) => c.links.length === 0 && c.groups.length === 1 && c.groups[0].length === 1;
const mentions = (c: Chain | Subgraph | Other, id: string) => c.kind === 'chain' && c.groups.some(g => g.some(n => n.id === id));
const definition = (src: string, n: NodeRef) => (n.shape || n.meta || n.cls ? src.slice(n.start, n.end) : null);

export interface GroupInfo {
	id: string;
	title: string;
	direction: Direction | null;
	/** A node of the group links to a node outside it: Mermaid then ignores the group's direction. */
	linkedOutside: boolean;
}

export function groupInfo(src: string, id: string): GroupInfo {
	const flow = read(src);
	const sg = groupOf(flow, id);
	const d = sg.directions[sg.directions.length - 1]?.arg;
	const inside = (n: string) => { const g = flow.memberOf.get(n); return !!g && (g === sg || isInside(g, sg)); };
	return {
		id, title: sg.title,
		direction: d === 'TB' || d === 'TD' || d === 'BT' || d === 'LR' || d === 'RL' ? d : null,
		linkedOutside: flow.edges.some(e => inside(e.from.id) !== inside(e.to.id)),
	};
}

/** Where an edge went after edits that may have moved it behind all others (`relinkEdge`). */
export function edgeAfter(src: string, index: number, from: string, to: string): number {
	const flow = read(src);
	const at = (i: number) => flow.edges[i] && flow.edges[i].from.id === from && flow.edges[i].to.id === to;
	if (at(index)) return index;
	if (at(flow.edges.length - 1)) return flow.edges.length - 1;
	throw new EditError('The link moved in the meantime, nothing was changed.');
}

/** Every group, outer ones first, for the dialogs' group list. */
export function groupsOf(src: string): { id: string; title: string; depth: number }[] {
	const depth = (sg: Subgraph) => { let d = 0; for (let p = sg.parent; p; p = p.parent) d++; return d; };
	return read(src).subgraphs.map(sg => ({ id: sg.id, title: sg.title || sg.id, depth: depth(sg) }));
}

/**
 * Moves a node into a group, or with null out of every group. Mermaid puts a node into the first
 * group (in closing order) whose block mentions it, so mentions in groups that would claim it
 * first go: a statement with edges moves out of the block, behind every edge (`linkStyle`
 * follows), its other nodes keeping a mention in the group. Bare mentions of the node outside the
 * target are removed; the target gets one mention. Moved text keeps only the definitions that win
 * (Mermaid uses a node's last one), so moving it cannot change another node's label.
 */
export function moveToGroup(src: string, id: string, groupId: string | null): string {
	const flow = read(src);
	const all = mentionsOf(flow, id);
	if (flow.subgraphs.some(x => x.id === id)) throw new EditError('Moving a group into another group is not supported yet, edit it in the source.');
	const target = groupId === null ? null : groupOf(flow, groupId);
	if ((flow.memberOf.get(id) ?? null) === target) return src;
	if (target && (target.id === id)) throw new EditError('A node cannot go into itself.');
	const claims = flow.subgraphs.filter(sg => sg !== target && (target === null || sg.closeIndex < target.closeIndex));
	const splices: Splice[] = [];
	const moved: Chain[] = [];
	let def: string | null = null;
	let left = all.length;
	// Bare mentions (`A`, `A[Label]`) outside the target go wherever they stand: the node gets one
	// mention in the target, with the definition that wins.
	const bare = flow.chains.filter(c => isMention(c) && c.groups[0][0].id === id && (target === null ? !!c.parent && claims.includes(c.parent) : c.parent !== target));
	for (const c of bare) {
		const n = c.groups[0][0];
		if (winner(flow, id) === n) def = src.slice(n.start, n.end);
		left--;
		splices.push(removal(src, c));
	}
	for (const sg of claims) {
		const here = sg.members.filter((m): m is Chain => m.kind === 'chain' && mentions(m, id));
		const toMove = here.filter(c => !isMention(c));
		for (const c of toMove) {
			moved.push(c);
			// Its other nodes stay in this group when this statement is what keeps them there.
			const stay = [...new Set(c.groups.flat().map(n => n.id))].filter(o => o !== id && flow.memberOf.get(o) === sg
				&& !sg.members.some(m => m.kind === 'chain' && !toMove.includes(m) && mentions(m, o)));
			splices.push(stay.length ? { start: c.start, end: c.end, text: stay.join(`\n${indentAt(src, c.start)}`) } : removal(src, c));
		}
	}
	const lines = moved.sort((a, b) => a.start - b.start).map(c => withWinnersOnly(flow, c));
	if (target) {
		if (def || !target.members.some(m => mentions(m, id))) splices.push(insertInto(src, target, [def ?? id]));
	} else if (def || left === 0 && !moved.length) {
		lines.push(def ?? id);
	}
	if (lines.length) splices.push(insertAfter(flow, afterEdges(flow), lines));
	// Edges of moved statements now come after all others.
	const movedEdges = flow.edges.filter(e => moved.includes(e.chain)).map(e => e.index);
	if (movedEdges.length) {
		const kept = flow.edges.length - movedEdges.length;
		splices.push(...renumberLinkStyles(flow, n => {
			const m = movedEdges.indexOf(n);
			return m >= 0 ? kept + m : n - movedEdges.filter(x => x < n).length;
		}));
	}
	return checked(src, applySplices(src, splices), m => m.group.set(id, target?.title ?? ''));
}

/** The mention of a node whose shape and label Mermaid uses: its last definition. */
function winner(flow: Flow, id: string): NodeRef | null {
	return [...(flow.nodes.get(id) ?? [])].reverse().find(n => n.shape || n.meta) ?? null;
}

/** A chain's text with the shapes and labels that do not win dropped (classes stay). */
function withWinnersOnly(flow: Flow, c: Chain): string {
	const cut: Splice[] = [];
	for (const n of c.groups.flat()) {
		const def = n.shape ?? n.meta;
		if (def && winner(flow, n.id) !== n) cut.push({ start: def.start - c.start, end: def.end - c.start, text: '' });
	}
	return applySplices(flow.src.slice(c.start, c.end), cut);
}

/**
 * Puts a node into a new group titled `title`: a block of its own at the top level, or inside the
 * node's current group (nested, so it closes first and takes the node).
 */
export function addGroup(src: string, title: string, nodeId: string): string {
	const flow = read(src);
	mentionsOf(flow, nodeId);
	const t = labelText(title, null, 'title');
	const id = newId(flow, title.trim() || 'Group');
	const current = flow.memberOf.get(nodeId);
	const name = cleanText(title, 'title');
	const expect = (m: Meaning) => {
		swap(m.groups, null, `${current?.title ?? ''}>${name}`);
		m.group.set(nodeId, name);
	};
	if (current) {
		const indent = memberIndent(src, current);
		const block = [`subgraph ${id} [${t}]`, `  ${nodeId}`, 'end'];
		const ls = src.lastIndexOf('\n', current.endStart - 1) + 1;
		if (src.slice(ls, current.endStart).trim()) throw new EditError('The group\'s `end` shares its line with other statements, edit it in the source.');
		return checked(src, applySplices(src, [{ start: ls, end: ls, text: block.map(l => `${indent}${l}\n`).join('') }]), expect);
	}
	return checked(src, applySplices(src, [insertAfter(flow, afterNodes(flow), [`subgraph ${id} [${t}]`, `  ${nodeId}`, 'end'])]), expect);
}

/**
 * Sets a group's title. A group written without brackets (`subgraph Name`, `subgraph "Two words"`)
 * becomes `subgraph <id> [Title]`: its id stays what it was, and a generated `subGraphN` (which
 * shifts when other groups come or go) is replaced by one from the title unless something names it
 * (code review 0.18.0: retitling to a node's name had swallowed that node).
 */
export function setGroupTitle(src: string, id: string, title: string): string {
	const flow = read(src);
	const sg = groupOf(flow, id);
	const l = sg.titleLabel;
	if (!l) throw new EditError('This group has no title to change.');
	const name = cleanText(title, 'title');
	const expect = (m: Meaning) => retitle(m, sg.title, name);
	const head = src.slice(sg.start, sg.headEnd);
	if (head.includes('[')) return checked(src, applySplices(src, [{ start: l.start, end: l.end, text: labelText(title, l, 'title') }]), expect);
	const keep = !sg.auto || referenced(flow, sg.id) ? sg.id : newId(flow, title);
	const at = sg.start + 'subgraph'.length;
	return checked(src, applySplices(src, [{ start: at, end: sg.headEnd, text: ` ${keep} [${labelText(title, null, 'title')}]` }]), expect);
}

/** Sets (or with null removes) a group's own direction, `direction LR` in its block. */
export function setGroupDirection(src: string, id: string, dir: Direction | null): string {
	const flow = read(src);
	const sg = groupOf(flow, id);
	const own = sg.directions;
	const splices: Splice[] = own.slice(0, dir ? -1 : undefined).map(o => removal(src, o));
	const last = own[own.length - 1];
	if (dir && last) {
		if (last.arg === dir) return checked(src, applySplices(src, splices), () => {});
		splices.push({ start: last.argStart, end: last.argEnd, text: ` ${dir}` });
	} else if (dir) {
		// On a line of its own right after the head: Mermaid reads a whole line containing
		// `direction XY` as one statement, so nothing may follow it there (code review 0.18.0).
		const indent = memberIndent(src, sg);
		let i = sg.headEnd;
		while (isBlank(src[i])) i++;
		if (src[i] === ';') {
			let j = i + 1;
			while (isBlank(src[j])) j++;
			splices.push({ start: sg.headEnd, end: j, text: `\n${indent}direction ${dir}\n${indent}` });
		} else {
			splices.push({ start: sg.headEnd, end: sg.headEnd, text: `\n${indent}direction ${dir}` });
		}
	}
	return checked(src, applySplices(src, splices), () => {});
}

/** Whether edges, styles or classes name the group itself (they would turn into a node). */
function referenced(flow: Flow, id: string): boolean {
	return flow.chains.some(c => mentions(c, id))
		|| flow.others.some(o => (o.kind === 'style' || o.kind === 'click' || o.kind === 'class') && o.arg.split(',').map(x => x.trim()).includes(id));
}

/**
 * Dissolves a group: its `subgraph` and `end` lines go, its statements stay (one level less
 * indented) and belong to the enclosing group or the top level. Its own `direction` goes too.
 */
export function ungroup(src: string, id: string): string {
	const flow = read(src);
	const sg = groupOf(flow, id);
	if (referenced(flow, id)) throw new EditError('Edges or styles refer to this group itself; remove them first, or edit it in the source.');
	const splices: Splice[] = [removal(src, { start: sg.start, end: sg.headEnd }), removal(src, { start: sg.endStart, end: sg.endEnd })];
	for (const d of sg.directions) splices.push(removal(src, d));
	// One level less indented, but only lines where a statement starts: a continuation line of a
	// multi-line directive, `accDescr` or label keeps its text exactly (moving an indented fence to
	// column 0 would end the code block, security review O69).
	const extra = memberIndent(src, sg).length - indentAt(src, sg.start).length;
	if (extra > 0) {
		const starts = new Set<number>();
		const add = (st: { start: number }) => starts.add(st.start);
		for (const c of flow.chains) if (c.parent === sg || (c.parent && isInside(c, sg))) add(c);
		for (const o of flow.others) if (o.parent === sg || (o.parent && isInside(o, sg))) add(o);
		for (const x of flow.subgraphs) if (x !== sg && isInside(x, sg)) { add(x); starts.add(x.endStart); }
		let ls = src.indexOf('\n', sg.headEnd) + 1;
		const endLine = src.lastIndexOf('\n', sg.endStart - 1) + 1;
		while (ls > 0 && ls < endLine) {
			let first = ls;
			while (src[first] === ' ' || src[first] === '\t') first++;
			if (starts.has(first)) {
				let k = 0;
				while (k < extra && (src[ls + k] === ' ' || src[ls + k] === '\t')) k++;
				if (k) splices.push({ start: ls, end: ls + k, text: '' });
			}
			ls = src.indexOf('\n', ls) + 1;
		}
	}
	return checked(src, applySplices(src, splices), m => retitle(m, sg.title, null, sg.parent?.title ?? ''));
}

/**
 * Deletes a group with everything in it: its block, the nodes that belong to it (or to groups
 * inside it), every edge at them or at the group, and their style entries. A node that is only
 * mentioned in the block but belongs elsewhere keeps a mention at the top level.
 */
export function deleteGroup(src: string, id: string): string {
	const flow = read(src);
	const sg = groupOf(flow, id);
	const inner = new Set(flow.subgraphs.filter(x => x === sg || isInside(x, sg)).map(x => x.id));
	const doomed = new Set<string>(inner);
	for (const [n, g] of flow.memberOf) if (inner.has(g.id)) doomed.add(n);
	const inBlock = (c: Chain) => !!c.parent && (c.parent === sg || isInside(c, sg));
	const splices: Splice[] = [removal(src, { start: sg.start, end: sg.endEnd })];
	const removed = new Set<number>();
	const survivors = new Map<string, string>();
	for (const c of flow.chains) {
		const plans = plansOf(flow, c);
		if (inBlock(c)) {
			for (const p of plans) removed.add(p.edge.index);
			for (const n of c.groups.flat()) {
				if (doomed.has(n.id) || (flow.nodes.get(n.id) ?? []).some(m => !inBlock(chainOf(flow, m)))) continue;
				if (!survivors.has(n.id) || definition(src, n)) survivors.set(n.id, definition(src, n) ?? n.id);
			}
			continue;
		}
		if (!c.groups.some(g => g.some(n => doomed.has(n.id)))) continue;
		const keep = plans.filter(p => {
			const gone = doomed.has(p.from.id) || doomed.has(p.to.id);
			if (gone) removed.add(p.edge.index);
			return !gone;
		});
		splices.push(rewriteChain(flow, c, keep, doomed));
	}
	for (const o of flow.others) {
		if (o.parent && (o.parent === sg || isInside(o, sg))) continue;
		if ((o.kind === 'style' || o.kind === 'click') && doomed.has(o.arg)) splices.push(removal(src, o));
		if (o.kind === 'class') {
			const ids = o.arg.split(',').map(x => x.trim());
			const rest = ids.filter(x => !doomed.has(x));
			if (rest.length !== ids.length) splices.push(rest.length ? { start: o.argStart, end: o.argEnd, text: rest.join(',') } : removal(src, o));
		}
	}
	if (survivors.size) splices.push(insertAfter(flow, afterNodes(flow, sg), [...survivors.values()]));
	const innerTitles = new Set(flow.subgraphs.filter(x => inner.has(x.id)).map(x => x.title));
	return checked(src, applySplices(src, [...splices, ...remapLinkStyles(flow, removed)]), m => {
		for (const n of doomed) forget(m, n);
		for (const e of flow.edges) if (removed.has(e.index)) rekey(m, edgeKey(e), null);
		m.groups = m.groups.filter(g => !innerTitles.has(g.slice(g.indexOf('>') + 1)));
		m.refs = m.refs.filter(r => !inner.has(r.slice(0, r.indexOf('='))));
	});
}

function chainOf(flow: Flow, n: NodeRef): Chain {
	return flow.chains.find(c => c.groups.some(g => g.includes(n)))!;
}

export type { Arrow, ShapeType };
