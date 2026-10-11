/**
 * Reads a Mermaid flowchart (`flowchart` / `graph`, Mermaid 12.1) into statements, nodes and
 * edges with their offsets in the source. Pure text: no DOM, no Obsidian.
 *
 * Mermaid's flowchart parser (JISON) reports no positions, so this scanner finds them itself. It
 * follows the lexer rules of 12.1 for the parts the editor needs (node ids, shapes, labels, link
 * tokens, `&` groups, chains, subgraphs) and predicts the edge ids Mermaid assigns. Where it does
 * not understand a statement it says so (`error`); the editor then refuses to edit, and even a
 * successful scan is only used while its nodes and edges match the drawing exactly (`FlowModel`).
 *
 * Linear scans only (security rule since 0.13.0): index loops and sticky regexes whose
 * repetitions cannot overlap, on input bounded by MAX_SOURCE.
 */

export type ShapeType =
	| 'square' | 'round' | 'stadium' | 'subroutine' | 'cylinder' | 'circle' | 'doublecircle' | 'ellipse'
	| 'diamond' | 'hexagon' | 'odd' | 'lean_right' | 'lean_left' | 'trapezoid' | 'inv_trapezoid';

/** Bracket shapes, longest opener first (the order the lexer tries them in). */
export const SHAPES: readonly { type: ShapeType; open: string; close: string }[] = [
	{ type: 'doublecircle', open: '(((', close: ')))' },
	{ type: 'circle', open: '((', close: '))' },
	{ type: 'stadium', open: '([', close: '])' },
	{ type: 'ellipse', open: '(-', close: '-)' },
	{ type: 'round', open: '(', close: ')' },
	{ type: 'subroutine', open: '[[', close: ']]' },
	{ type: 'cylinder', open: '[(', close: ')]' },
	{ type: 'lean_right', open: '[/', close: '/]' },
	{ type: 'trapezoid', open: '[/', close: '\\]' },
	{ type: 'lean_left', open: '[\\', close: '\\]' },
	{ type: 'inv_trapezoid', open: '[\\', close: '/]' },
	{ type: 'square', open: '[', close: ']' },
	{ type: 'hexagon', open: '{{', close: '}}' },
	{ type: 'diamond', open: '{', close: '}' },
	{ type: 'odd', open: '>', close: ']' },
];

export type Stroke = 'normal' | 'thick' | 'dotted' | 'invisible';
export type Head = 'none' | 'arrow' | 'circle' | 'cross';
/** A link's look, as Mermaid reads it (`destructLink`): mixed ends do not exist. */
export interface Arrow { stroke: Stroke; head: Head; both: boolean; length: number }

/** Text in brackets, pipes or an inline edge label: its span in the source covers the quotes. */
export interface Label {
	start: number;
	end: number;
	/** The text as the user edits it: without quotes and markdown backticks. */
	text: string;
	quoted: boolean;
	markdown: boolean;
}

export interface NodeRef {
	id: string;
	/** From the first character of the id to the end of the shape, `@{…}` or `:::class`. */
	start: number;
	end: number;
	idEnd: number;
	shape: { type: ShapeType; open: string; close: string; start: number; end: number; label: Label } | null;
	/** `@{ … }` (new shape syntax), braces included. */
	meta: { start: number; end: number; body: string } | null;
	/** `:::name`. */
	cls: { start: number; end: number } | null;
}

export interface LinkRef {
	/** From the edge id (or the arrow) to the end of the label (pipe) or the closing arrow (inline). */
	start: number;
	end: number;
	/** The arrow token alone (after the id, before a pipe label); for an inline label the whole `-- text -->`. */
	arrowStart: number;
	arrowEnd: number;
	id: { name: string; start: number; end: number } | null;
	arrow: Arrow;
	label: { form: 'pipe' | 'inline'; label: Label } | null;
}

export interface Chain {
	kind: 'chain';
	start: number;
	end: number;
	/** Node groups joined by `&`, one more than there are links. */
	groups: NodeRef[][];
	links: LinkRef[];
	/** The innermost subgraph whose block holds the statement. */
	parent: Subgraph | null;
}

export interface Subgraph {
	kind: 'subgraph';
	/** The id Mermaid uses (its own `subGraphN` when the title has blanks and no id is given). */
	id: string;
	/** The id is Mermaid's generated `subGraphN`. */
	auto: boolean;
	title: string;
	/** `subgraph` keyword to the end of its statement. */
	start: number;
	headEnd: number;
	/** The `end` keyword; -1 while unclosed. */
	endStart: number;
	endEnd: number;
	parent: Subgraph | null;
	/** The title as written: in brackets after an id, or the whole text after `subgraph`. */
	titleLabel: Label | null;
	/** `direction XY` statements directly inside. */
	directions: Other[];
	/** Position among all subgraphs in the order Mermaid adds them (when they close). */
	closeIndex: number;
	/** Statements directly inside the block (nested subgraphs count as one each). */
	members: (Chain | Subgraph | Other)[];
}

export type OtherKind = 'style' | 'classDef' | 'class' | 'linkStyle' | 'click' | 'direction' | 'acc' | 'comment' | 'edgeMeta';
export interface Other {
	kind: OtherKind;
	start: number;
	end: number;
	/** `style`/`click`: the node; `class`: the node list; `linkStyle`: the index list (or `default`); `direction`: the value. */
	arg: string;
	argStart: number;
	argEnd: number;
	parent: Subgraph | null;
}

export interface Edge {
	/** Position in Mermaid's edge list: what `linkStyle N` counts. */
	index: number;
	/** The id Mermaid gives the edge, `data-id` of its path in the drawing. */
	id: string;
	chain: Chain;
	/** Which link of the chain. */
	link: number;
	from: NodeRef;
	to: NodeRef;
}

export interface Flow {
	src: string;
	/** `flowchart` / `graph` and its direction token. */
	header: { start: number; end: number; keyword: string; dir: { start: number; end: number; value: string } | null };
	statements: (Chain | Subgraph | Other)[];
	chains: Chain[];
	subgraphs: Subgraph[];
	others: Other[];
	edges: Edge[];
	/** Every node id with its mentions in source order (`style` targets count: Mermaid creates them). */
	nodes: Map<string, NodeRef[]>;
	/** Ids Mermaid creates a vertex for, in first-mention order (subgraph ids excluded). */
	vertexIds: string[];
	/** Which subgraph each node belongs to (Mermaid: the first to close that mentions it). */
	memberOf: Map<string, Subgraph>;
}

export class ScanError extends Error {}

/**
 * The last scans by source text: a dialog reads labels node by node and every edit scans before
 * and after, so the same text is scanned many times in a row (security review O70). A `Flow` is
 * never changed after `scan` returns, so sharing it is safe.
 */
const scans = new Map<string, Flow>();

export function scanCached(src: string): Flow {
	const hit = scans.get(src);
	if (hit) {
		scans.delete(src);
		scans.set(src, hit);
		return hit;
	}
	const flow = scan(src);
	scans.set(src, flow);
	if (scans.size > 16) scans.delete(scans.keys().next().value as string);
	return flow;
}

const isBlank = (c: string | undefined) => c === ' ' || c === '\t';
const isEol = (c: string | undefined) => c === undefined || c === '\n' || c === '\r';
const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

/**
 * Characters of Mermaid's NODE_STRING: `[A-Za-z0-9!"#$%&'*+.`?\\_/]`, a `-` not followed by `>`,
 * `-` or `.`, an `=` not followed by `=`, and letters beyond ASCII. Quotes are left out: an id
 * with a quote in it is not something the editor writes or needs to read.
 */
function isIdChar(s: string, i: number): boolean {
	const c = s[i];
	if (c === undefined) return false;
	if (/[A-Za-z0-9!#$%&'*+.`?\\_/]/.test(c)) return true;
	if (c === '-') { const n = s[i + 1]; return n !== undefined && n !== '>' && n !== '-' && n !== '.'; }
	if (c === '=') return s[i + 1] !== '=';
	return c.charCodeAt(0) >= 0xaa && /\p{L}/u.test(c);
}

/** Link tokens of the lexer, in its order. Sticky, tried at one index; no overlapping repetitions. */
const LINKS: { re: RegExp; stroke: Stroke; start: boolean }[] = [
	{ re: /[xo<]?--+[-xo>]/y, stroke: 'normal', start: false },
	{ re: /[xo<]?--/y, stroke: 'normal', start: true },
	{ re: /[xo<]?==+[=xo>]/y, stroke: 'thick', start: false },
	{ re: /[xo<]?==/y, stroke: 'thick', start: true },
	{ re: /[xo<]?-?\.+-[xo>]?/y, stroke: 'dotted', start: false },
	{ re: /[xo<]?-\./y, stroke: 'dotted', start: true },
	{ re: /~~~+/y, stroke: 'invisible', start: false },
];
/** The token that closes an inline label (`-- text -->`), per stroke. */
const LINK_END: Record<'normal' | 'thick' | 'dotted', RegExp> = {
	normal: /[ \t]*[xo<]?--+[-xo>]/y,
	thick: /[ \t]*[xo<]?==+[=xo>]/y,
	dotted: /[ \t]*[xo<]?-?\.+-[xo>]?/y,
};

const sticky = (re: RegExp, s: string, at: number): string | null => {
	re.lastIndex = at;
	const m = re.exec(s);
	return m ? m[0] : null;
};

/** Mermaid's `destructEndLink`/`destructLink` for one token or a start + end pair. */
export function readArrow(end: string, start?: string): Arrow {
	const str = end.trim();
	let line = str.slice(0, -1);
	let head: Head = 'none';
	let both = false;
	const last = str.slice(-1);
	const first = str[0];
	if (last === 'x' || last === '>' || last === 'o') {
		head = last === 'x' ? 'cross' : last === 'o' ? 'circle' : 'arrow';
		if (first === (last === '>' ? '<' : last)) { both = true; line = line.slice(1); }
	}
	let stroke: Stroke = 'normal';
	let length = line.length - 1;
	if (line.startsWith('=')) stroke = 'thick';
	if (line.startsWith('~')) stroke = 'invisible';
	const dots = [...line].filter(c => c === '.').length;
	if (dots) { stroke = 'dotted'; length = dots; }
	if (start !== undefined) {
		const st = start.trim();
		if ('<xo'.includes(st[0])) both = true;
	}
	return { stroke, head, both, length: Math.min(10, Math.max(1, length)) };
}

/** Reads `"…"` (no quotes inside) or the text up to `stop`; the label of a shape, pipe or subgraph title. */
function readText(s: string, at: number, stops: string): { label: Label; end: number } | null {
	let i = at;
	while (isBlank(s[i])) i++;
	if (s[i] === '"') {
		const close = s.indexOf('"', i + 1);
		if (close < 0) return null;
		const inner = s.slice(i + 1, close);
		const markdown = inner.length >= 2 && inner.startsWith('`') && inner.endsWith('`');
		let j = close + 1;
		while (isBlank(s[j])) j++;
		return { label: { start: i, end: close + 1, text: markdown ? inner.slice(1, -1) : inner, quoted: true, markdown }, end: j };
	}
	let j = at;
	while (j < s.length && !stops.includes(s[j])) j++;
	const raw = s.slice(at, j);
	const lead = raw.length - raw.trimStart().length;
	const text = raw.trim();
	return { label: { start: at + lead, end: at + lead + text.length, text, quoted: false, markdown: false }, end: j };
}

/** A scan position over one source. */
class Cursor {
	/** Next `@` at or after the last lookup (-1: none left); the end of the current run of non-blanks. */
	private at = -2;
	private run = -1;

	constructor(readonly s: string, public i = 0) {}

	/** The next `@` at or after `from`; lookups only move forward, so all of them together are linear. */
	nextAt(from: number): number {
		if (this.at !== -1 && this.at < from) this.at = this.s.indexOf('@', from);
		return this.at;
	}

	/** Where the run of characters without blanks or quotes that holds `from` ends. */
	runEnd(from: number): number {
		if (this.run < from) {
			let i = from;
			while (i < this.s.length && !/[\s"]/.test(this.s[i])) i++;
			this.run = i;
		}
		return this.run;
	}

	blanks() {
		while (isBlank(this.s[this.i])) this.i++;
	}

	/** At the end of a statement: a line break, `;` or the end. */
	atEnd(): boolean {
		const c = this.s[this.i];
		return c === undefined || c === '\n' || c === '\r' || c === ';';
	}

	word(w: string): boolean {
		return this.s.startsWith(w, this.i) && !isWord(this.s[this.i + w.length]);
	}

	/** To the end of the line or the next `;` outside double quotes. */
	toStatementEnd(): number {
		let i = this.i;
		let quoted = false;
		while (i < this.s.length) {
			const c = this.s[i];
			if (c === '"') quoted = !quoted;
			else if (!quoted && (c === '\n' || c === ';')) break;
			else if (c === '\n') break;
			i++;
		}
		return i;
	}

	toLineEnd(): number {
		const n = this.s.indexOf('\n', this.i);
		return n < 0 ? this.s.length : n;
	}
}

/**
 * Scans a flowchart source. Throws `ScanError` for what the scanner does not understand; a
 * source Mermaid itself rejects may scan or not, the editor validates every edit anyway.
 */
export function scan(src: string): Flow {
	const c = new Cursor(src);
	const flow: Flow = {
		src,
		header: { start: 0, end: 0, keyword: '', dir: null },
		statements: [], chains: [], subgraphs: [], others: [], edges: [],
		nodes: new Map(), vertexIds: [], memberOf: new Map(),
	};
	skipFrontmatter(c);
	let header = false;
	const stack: Subgraph[] = [];
	const linkIds = new Set<string>();
	/** Offset of the next `}%%` at or after the scan (-1: none left, -2: not looked up yet). */
	let directiveEnd = -2;
	let closed = 0;
	const parent = () => stack[stack.length - 1] ?? null;
	const add = (st: Chain | Subgraph | Other) => {
		const p = parent();
		if (p) p.members.push(st); else flow.statements.push(st);
	};
	const other = (kind: OtherKind, start: number, end: number, argStart: number, argEnd: number) => {
		const o: Other = { kind, start, end, arg: src.slice(argStart, argEnd).trim(), argStart, argEnd, parent: parent() };
		flow.others.push(o);
		add(o);
		return o;
	};

	while (c.i < src.length) {
		const ch = src[c.i];
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ';') { c.i++; continue; }
		const start = c.i;
		if (src.startsWith('%%', c.i)) {
			// Comments and directives (`%%{init: …}%%`, which may span lines). The next `}%%` is looked
			// up once and reused: searching from every `%%{` line was quadratic (security review O70).
			if (src.startsWith('%%{', c.i) && directiveEnd !== -1 && directiveEnd < c.i) directiveEnd = src.indexOf('}%%', c.i);
			const close = src.startsWith('%%{', c.i) ? directiveEnd : -1;
			c.i = close >= 0 ? close + 3 : c.toLineEnd();
			other('comment', start, c.i, start, start);
			continue;
		}
		if (!header) {
			const m = /^(flowchart-elk|flowchart|graph)\b/.exec(src.slice(c.i, c.i + 20));
			if (!m) throw new ScanError('Not a flowchart.');
			c.i += m[0].length;
			flow.header = { start, end: c.i, keyword: m[0], dir: null };
			c.blanks();
			const d = /^(TD|TB|BT|RL|LR|BR)\b|^[<>^]|^v\b/.exec(src.slice(c.i, c.i + 3));
			if (d) {
				flow.header.dir = { start: c.i, end: c.i + d[0].length, value: d[0] };
				c.i += d[0].length;
				flow.header.end = c.i;
			}
			c.blanks();
			if (!c.atEnd()) throw new ScanError('Unexpected text after the flowchart header.');
			header = true;
			continue;
		}
		if (c.word('subgraph')) {
			c.i += 'subgraph'.length;
			const end = c.toStatementEnd();
			const sg = readSubgraphHead(src, start, c.i, end, parent());
			c.i = end;
			add(sg);
			flow.subgraphs.push(sg);
			stack.push(sg);
			continue;
		}
		if (c.word('end')) {
			const sg = stack.pop();
			if (!sg) throw new ScanError('`end` without a subgraph.');
			c.i += 3;
			sg.endStart = start;
			sg.endEnd = c.i;
			sg.closeIndex = closed++;
			continue;
		}
		if (c.word('direction')) {
			const end = c.toLineEnd();
			const o = other('direction', start, end, start + 'direction'.length, end);
			parent()?.directions.push(o);
			c.i = end;
			continue;
		}
		const keyword = /^(style|classDef|class|linkStyle|click|accTitle|accDescr)\b/.exec(src.slice(c.i, c.i + 10));
		if (keyword) {
			const k = keyword[1];
			if (k === 'accTitle' || k === 'accDescr') {
				c.i += k.length;
				c.blanks();
				if (src[c.i] === '{') {
					const close = src.indexOf('}', c.i);
					if (close < 0) throw new ScanError('Unclosed accDescr block.');
					c.i = close + 1;
				} else {
					c.i = c.toLineEnd();
				}
				other('acc', start, c.i, start, c.i);
				continue;
			}
			c.i += k.length;
			c.blanks();
			const end = c.toStatementEnd();
			const kind = k as OtherKind;
			// The first argument: the node of `style`/`click`, the node list of `class`, the indices of `linkStyle`.
			let argEnd = c.i;
			while (argEnd < end && !isBlank(src[argEnd])) argEnd++;
			const o = other(kind, start, end, c.i, kind === 'classDef' ? c.i : argEnd);
			if (kind === 'style') mention(flow, { id: o.arg, start: o.argStart, end: o.argEnd, idEnd: o.argEnd, shape: null, meta: null, cls: null }, true);
			c.i = end;
			continue;
		}
		const chain = readChain(c, parent());
		const only = chain.links.length === 0 && chain.groups[0].length === 1 ? chain.groups[0][0] : null;
		if (only?.meta && linkIds.has(only.id)) {
			// `e1@{ animate: true }`: metadata of the edge `e1` defined before it, not a node (Mermaid's addVertex).
			other('edgeMeta', chain.start, chain.end, only.start, only.idEnd);
			continue;
		}
		for (const l of chain.links) if (l.id) linkIds.add(l.id.name);
		flow.chains.push(chain);
		add(chain);
		for (const g of chain.groups) for (const n of g) mention(flow, n, false);
	}
	if (!header) throw new ScanError('Not a flowchart.');
	if (stack.length) throw new ScanError('A subgraph is not closed with `end`.');

	assignSubgraphIds(flow);
	const subgraphIds = new Set(flow.subgraphs.map(s => s.id));
	flow.vertexIds = flow.vertexIds.filter(id => !subgraphIds.has(id));
	flow.edges = edgesOf(flow.chains);
	flow.memberOf = membership(flow);
	return flow;
}

function skipFrontmatter(c: Cursor) {
	const m = /^-{3}[ \t]*\r?\n/.exec(c.s);
	if (!m) return;
	const close = /\r?\n-{3}[ \t]*(?:\r?\n|$)/g;
	close.lastIndex = m[0].length - 1;
	const e = close.exec(c.s);
	if (!e) throw new ScanError('Unclosed frontmatter.');
	c.i = e.index + e[0].length;
}

function mention(flow: Flow, n: NodeRef, styleOnly: boolean) {
	const list = flow.nodes.get(n.id);
	if (list) {
		if (!styleOnly) list.push(n);
		return;
	}
	flow.nodes.set(n.id, styleOnly ? [] : [n]);
	flow.vertexIds.push(n.id);
}

/** `subgraph id`, `subgraph id [title]`, `subgraph "title"`, `subgraph title with blanks`. */
function readSubgraphHead(s: string, start: number, at: number, end: number, parent: Subgraph | null): Subgraph {
	const sg: Subgraph = {
		kind: 'subgraph', id: '', auto: false, title: '', start, headEnd: end, endStart: -1, endEnd: -1, parent, titleLabel: null,
		directions: [], closeIndex: -1, members: [],
	};
	let i = at;
	while (isBlank(s[i])) i++;
	if (i >= end) throw new ScanError('A subgraph needs an id or a title.');
	let bracket = -1;
	let quoted = false;
	for (let j = i; j < end; j++) {
		if (s[j] === '"') quoted = !quoted;
		else if (!quoted && s[j] === '[') { bracket = j; break; }
	}
	if (bracket >= 0) {
		const close = s.lastIndexOf(']', end);
		if (close < bracket) throw new ScanError('Unclosed subgraph title.');
		sg.id = s.slice(i, bracket).trim();
		const t = readText(s, bracket + 1, ']');
		if (!t) throw new ScanError('Unreadable subgraph title.');
		sg.titleLabel = t.label;
		sg.title = t.label.text;
		return sg;
	}
	const t = readText(s, i, '\n;');
	if (!t) throw new ScanError('Unreadable subgraph title.');
	sg.titleLabel = t.label;
	sg.title = t.label.text;
	// Mermaid: without brackets the text is id and title; with a blank in it, the id is generated.
	sg.id = /\s/.test(sg.title) ? '' : sg.title;
	return sg;
}

/** Mermaid numbers generated subgraph ids by the order the subgraphs close (`subGraphN`). */
function assignSubgraphIds(flow: Flow) {
	for (const sg of flow.subgraphs) if (!sg.id) { sg.id = `subGraph${sg.closeIndex}`; sg.auto = true; }
}

/** One vertex statement: node groups joined by links, e.g. `A & B --> C[Label] -.->|x| D`. */
function readChain(c: Cursor, parent: Subgraph | null): Chain {
	const start = c.i;
	const groups: NodeRef[][] = [[readNode(c)]];
	const links: LinkRef[] = [];
	for (;;) {
		c.blanks();
		if (c.atEnd()) break;
		if (c.s[c.i] === '&') {
			// The lexer takes the longest token: `&B` is a node id, only `& B` joins a group.
			if (isIdChar(c.s, c.i + 1)) throw new ScanError('`&` needs a blank after it.');
			c.i++;
			c.blanks();
			groups[groups.length - 1].push(readNode(c));
			continue;
		}
		links.push(readLink(c));
		c.blanks();
		groups.push([readNode(c)]);
	}
	let end = c.i;
	while (end > start && isBlank(c.s[end - 1])) end--;
	return { kind: 'chain', start, end, groups, links, parent };
}

function readNode(c: Cursor): NodeRef {
	const s = c.s;
	const start = c.i;
	while (isIdChar(s, c.i)) c.i++;
	if (c.i === start) throw new ScanError(`Unexpected "${s.slice(start, start + 12).split('\n')[0]}".`);
	const id = s.slice(start, c.i);
	if (/^(end|subgraph|style|classDef|class|linkStyle|click|graph|flowchart)$/.test(id)) throw new ScanError(`"${id}" is a keyword.`);
	const node: NodeRef = { id, start, end: c.i, idEnd: c.i, shape: null, meta: null, cls: null };
	if (s.startsWith('@{', c.i)) {
		const close = closeBrace(s, c.i + 2);
		if (close < 0) throw new ScanError('Unclosed `@{`.');
		node.meta = { start: c.i, end: close + 1, body: s.slice(c.i + 2, close) };
		c.i = close + 1;
	} else {
		const shape = readShape(s, c.i);
		if (shape) {
			node.shape = shape;
			c.i = shape.end;
		}
	}
	if (s.startsWith(':::', c.i)) {
		const at = c.i;
		c.i += 3;
		const n0 = c.i;
		while (isIdChar(s, c.i)) c.i++;
		if (c.i === n0) throw new ScanError('A class name is missing after `:::`.');
		node.cls = { start: at, end: c.i };
	}
	node.end = c.i;
	return node;
}

/** The `}` that closes `@{`, skipping double-quoted strings (which may hold braces). */
function closeBrace(s: string, at: number): number {
	let quoted = false;
	for (let i = at; i < s.length; i++) {
		if (s[i] === '"') quoted = !quoted;
		else if (!quoted && s[i] === '}') return i;
	}
	return -1;
}

function readShape(s: string, at: number): NodeRef['shape'] {
	const opener = SHAPES.find(sh => s.startsWith(sh.open, at));
	if (!opener) return null;
	const textAt = at + opener.open.length;
	// Text state: no brackets, pipes or quotes unquoted. Trapezoids may hold / and \ not before `]`.
	if (opener.type === 'ellipse') {
		const q = readText(s, textAt, '');
		if (q?.label.quoted && s.startsWith('-)', q.end)) return { type: 'ellipse', open: '(-', close: '-)', start: at, end: q.end + 2, label: q.label };
		const close = s.indexOf('-)', textAt);
		if (close < 0) throw new ScanError('Unclosed shape.');
		const raw = s.slice(textAt, close);
		const lead = raw.length - raw.trimStart().length;
		const label: Label = { start: textAt + lead, end: textAt + lead + raw.trim().length, text: raw.trim(), quoted: false, markdown: false };
		return { type: 'ellipse', open: '(-', close: '-)', start: at, end: close + 2, label };
	}
	const trap = opener.open === '[/' || opener.open === '[\\';
	const t = readText(s, textAt, trap ? ']' : '[](){}|"');
	if (!t) throw new ScanError('Unclosed quote in a label.');
	let close = t.end;
	if (trap) {
		// The text ends at the first `]`; the character before it decides the shape.
		if (t.label.quoted) close = s[close + 1] === ']' ? close + 1 : -1;
		const before = s[close - 1];
		if (close < 0 || s[close] !== ']' || (before !== '/' && before !== '\\')) throw new ScanError('Unclosed shape.');
		const closer = before + ']';
		const sh = SHAPES.find(x => x.open === opener.open && x.close === closer)!;
		if (!t.label.quoted) {
			const raw = s.slice(textAt, close - 1);
			const lead = raw.length - raw.trimStart().length;
			t.label.start = textAt + lead;
			t.label.end = textAt + lead + raw.trim().length;
			t.label.text = raw.trim();
		}
		return { type: sh.type, open: sh.open, close: sh.close, start: at, end: close + 1, label: t.label };
	}
	if (!s.startsWith(opener.close, close)) throw new ScanError(`Expected "${opener.close}" to close "${opener.open}".`);
	return { type: opener.type, open: opener.open, close: opener.close, start: at, end: close + opener.close.length, label: t.label };
}

/** Run of characters the lexer's LINK_ID rule takes (`[^\s"]+@(?=[^{"])`), ending at the id's `@`. */
function readLinkId(c: Cursor, at: number): { name: string; end: number } | null {
	// Most links have no id: without an `@` before the run ends there is nothing to read. Reading
	// the whole run at every link of a chain written without blanks was quadratic (O70), so the
	// next `@` and the run's end come from forward-only lookups on the cursor.
	const s = c.s;
	const sign = c.nextAt(at), end = c.runEnd(at);
	if (sign < 0 || sign >= end) return null;
	let atSign = -1;
	for (let i = sign; i < end; i++) if (s[i] === '@' && i + 1 < s.length && s[i + 1] !== '{' && s[i + 1] !== '"') atSign = i;
	return atSign > at ? { name: s.slice(at, atSign), end: atSign + 1 } : null;
}

function readLink(c: Cursor): LinkRef {
	const s = c.s;
	const start = c.i;
	let id: LinkRef['id'] = null;
	const lid = readLinkId(c, c.i);
	if (lid) {
		id = { name: lid.name, start: c.i, end: lid.end };
		c.i = lid.end;
	}
	const tok = LINKS.map(l => ({ l, m: sticky(l.re, s, c.i) })).find(x => x.m !== null);
	if (!tok) throw new ScanError(`Unexpected "${s.slice(c.i, c.i + 12).split('\n')[0]}".`);
	const opening = tok.m!;
	const arrowStart = c.i;
	c.i += opening.length;
	const arrowEnd = c.i;
	if (!tok.l.start) {
		let end = c.i;
		let label: LinkRef['label'] = null;
		const before = c.i;
		c.blanks();
		if (s[c.i] === '|') {
			const t = readText(s, c.i + 1, '|');
			if (!t || s[t.end] !== '|') throw new ScanError('Unclosed `|` label.');
			label = { form: 'pipe', label: t.label };
			c.i = t.end + 1;
			end = c.i;
		} else {
			c.i = before;
		}
		return { start, end, arrowStart, arrowEnd, id, arrow: readArrow(opening), label };
	}
	// Inline label: `-- text -->`, `== text ==>`, `-. text .->`, up to the closing token on the same line.
	const close = LINK_END[tok.l.stroke as 'normal' | 'thick' | 'dotted'];
	const textAt = c.i;
	let i = c.i;
	let closing: string | null = null;
	while (i < s.length && !isEol(s[i])) {
		closing = sticky(close, s, i);
		if (closing) break;
		// The closing token takes leading blanks and runs of dots: failing at the first of a run, it
		// fails on the whole run (else a run of blanks or dots costs its length squared, O70).
		if (isBlank(s[i])) { while (isBlank(s[i])) i++; continue; }
		if (s[i] === '.') { while (s[i] === '.') i++; continue; }
		i++;
	}
	if (!closing) throw new ScanError('An inline edge label is not closed.');
	const raw = s.slice(textAt, i);
	const lead = raw.length - raw.trimStart().length;
	const text = raw.trim();
	const quoted = text.length >= 2 && text.startsWith('"') && text.endsWith('"');
	const label: Label = { start: textAt + lead, end: textAt + lead + text.length, text: quoted ? text.slice(1, -1) : text, quoted, markdown: false };
	c.i = i + closing.length;
	return { start, end: c.i, arrowStart, arrowEnd: c.i, id, arrow: readArrow(closing.trim(), opening), label: { form: 'inline', label } };
}

/**
 * Mermaid's edge list in its order: per link, every start of the left group with every end of
 * the right group (start-major). A user id (`e1@`) goes to the last start with the first end;
 * other ids are `L_<start>_<end>_<n>`, n = 0 for the first such pair, else their count + 1.
 */
/** Mermaid's own limit (`maxEdges`); it refuses a flowchart with more. */
export const MAX_EDGES = 500;

function edgesOf(chains: Chain[]): Edge[] {
	const edges: Edge[] = [];
	const ids = new Set<string>();
	const pairs = new Map<string, number>();
	for (const chain of chains) {
		chain.links.forEach((link, li) => {
			const left = chain.groups[li], right = chain.groups[li + 1];
			// `&` groups multiply: count before expanding (64 lines made 984,064 edges, O70).
			if (edges.length + left.length * right.length > MAX_EDGES) throw new ScanError(`More than ${MAX_EDGES} links.`);
			for (const from of left) {
				for (const to of right) {
					const key = `${from.id}\u0000${to.id}`;
					const userId = link.id && from === left[left.length - 1] && to === right[0] && !ids.has(link.id.name) ? link.id.name : null;
					const existing = pairs.get(key) ?? 0;
					const id = userId ?? `L_${from.id}_${to.id}_${existing === 0 ? 0 : existing + 1}`;
					pairs.set(key, existing + 1);
					ids.add(id);
					edges.push({ index: edges.length, id, chain, link: li, from, to });
				}
			}
		});
	}
	return edges;
}

/**
 * Subgraph membership as Mermaid computes it: each subgraph, in the order they close, takes
 * the nodes its own statements mention that no earlier one took.
 */
function membership(flow: Flow): Map<string, Subgraph> {
	const out = new Map<string, Subgraph>();
	const byClose = [...flow.subgraphs].sort((a, b) => a.closeIndex - b.closeIndex);
	for (const sg of byClose) {
		for (const m of sg.members) {
			if (m.kind !== 'chain') continue;
			for (const g of m.groups) for (const n of g) if (!out.has(n.id) && n.id !== sg.id) out.set(n.id, sg);
		}
	}
	return out;
}

/** Whether a statement lies inside `sg`, at any depth. */
export function isInside(st: { parent: Subgraph | null }, sg: Subgraph): boolean {
	for (let p = st.parent; p; p = p.parent) if (p === sg) return true;
	return false;
}
