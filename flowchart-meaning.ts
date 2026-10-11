/**
 * What a flowchart means, as far as an edit has to keep it: every node's label, shape and group,
 * the edges, which edge each `linkStyle` styles, the groups and the group ids other statements
 * name. Pure text, no DOM.
 *
 * Every flowchart edit is checked with it at run time (code review 0.18.0): the meaning of the new
 * source has to equal the old one changed exactly as that edit intends, or the edit is refused.
 * Ordering details Mermaid's text allows to differ (which definition of a node wins, which group
 * claims it first, how `linkStyle` counts) are the scanner's job; this check makes a gap there a
 * refusal instead of a silent change to parts of the diagram nobody touched.
 */
import { EditError } from './blocks';
import { Arrow, Edge, Flow, ScanError, scanCached } from './flowchart-scan';

export interface Meaning {
	/** Node id → its label as Mermaid shows it (the last definition wins; the id without one). */
	label: Map<string, string>;
	/** Node id → its shape (`square` …, a `@{ shape }` name, or '' for the default). */
	shape: Map<string, string>;
	/** Node id → the title of its group, '' at the top level. */
	group: Map<string, string>;
	/** Every edge as `from>to:type/stroke/length|label#id`, sorted. */
	edges: string[];
	/** Every edge a `linkStyle` statement styles, with that statement's css, sorted. */
	styled: string[];
	/** Every group as `parent title>title`, sorted. */
	groups: string[];
	/** Group ids that other statements name (edges, style, class, click), as `id=title`, sorted. */
	refs: string[];
}

/** Mermaid's edge type for an arrow (`destructLink`). */
export const edgeType = (a: Arrow) =>
	(a.both && a.head !== 'none' ? 'double_' : '') + { none: 'arrow_open', arrow: 'arrow_point', circle: 'arrow_circle', cross: 'arrow_cross' }[a.head];

/** An arrow as Mermaid stores it: an invisible link has no ends, a line without heads no `both`. */
export function normalArrow(a: Arrow): Arrow {
	const length = Math.max(1, Math.min(10, Math.round(a.length)));
	if (a.stroke === 'invisible') return { stroke: 'invisible', head: 'none', both: false, length };
	return { ...a, both: a.head === 'none' ? false : a.both, length };
}

export const edgeKeyOf = (from: string, to: string, arrow: Arrow, label: string, id: string | null) => {
	const a = normalArrow(arrow);
	return `${from}>${to}:${edgeType(a)}/${a.stroke}/${a.length}|${label}${id ? `#${id}` : ''}`;
};

/** The key of a scanned edge (its user id kept, a generated one not: those shift when edges move). */
export function edgeKey(e: Edge): string {
	const link = e.chain.links[e.link];
	const user = link.id && link.id.name === e.id ? e.id : null;
	return edgeKeyOf(e.from.id, e.to.id, link.arrow, link.label?.label.text ?? '', user);
}

export function meaning(flow: Flow): Meaning {
	const label = new Map<string, string>(), shape = new Map<string, string>(), group = new Map<string, string>();
	for (const id of flow.vertexIds) {
		let text = id, type = '';
		for (const n of flow.nodes.get(id) ?? []) {
			if (n.shape) { text = n.shape.label.text; type = n.shape.type; }
			if (n.meta) {
				const s = metaField(n.meta.body, 'shape'), l = metaField(n.meta.body, 'label');
				if (s !== null) type = s;
				if (l !== null) text = l;
			}
		}
		label.set(id, text);
		shape.set(id, type);
		group.set(id, flow.memberOf.get(id)?.title ?? '');
	}
	const styled: string[] = [];
	for (const o of flow.others) {
		if (o.kind !== 'linkStyle' || o.arg === 'default') continue;
		const css = flow.src.slice(o.argEnd, o.end).trim();
		for (const i of o.arg.split(',').map(x => Number(x.trim()))) {
			const e = flow.edges[i];
			styled.push(`${e ? edgeKey(e) : `missing ${i}`} ${css}`);
		}
	}
	const ids = new Map(flow.subgraphs.map(s => [s.id, s.title]));
	const named = new Set<string>();
	for (const c of flow.chains) for (const g of c.groups) for (const n of g) if (ids.has(n.id)) named.add(n.id);
	for (const o of flow.others) {
		if (o.kind === 'style' || o.kind === 'click' || o.kind === 'class') for (const x of o.arg.split(',')) if (ids.has(x.trim())) named.add(x.trim());
	}
	return {
		label, shape, group,
		edges: flow.edges.map(edgeKey).sort(),
		styled: styled.sort(),
		groups: flow.subgraphs.map(s => `${s.parent?.title ?? ''}>${s.title}`).sort(),
		refs: [...named].map(id => `${id}=${ids.get(id)}`).sort(),
	};
}

/** The value of `key:` in a `@{ … }` body, unquoted, or null. */
export function metaField(body: string, key: string): string | null {
	const m = new RegExp(`(?:^|[\\s,{])${key}[ \\t]*:[ \\t]*`).exec(body);
	if (!m) return null;
	const at = m.index + m[0].length;
	if (body[at] === '"') {
		const close = body.indexOf('"', at + 1);
		return close < 0 ? null : body.slice(at + 1, close);
	}
	let end = at;
	while (end < body.length && body[end] !== ',' && body[end] !== '\n' && body[end] !== '}') end++;
	return body.slice(at, end).trim();
}

/** Replaces one occurrence of `old` in a sorted list (null: removes it; `next` null: only removes). */
export function swap(list: string[], old: string | null, next: string | null): void {
	if (old !== null) {
		const i = list.indexOf(old);
		if (i >= 0) list.splice(i, 1);
	}
	if (next !== null) list.push(next);
	list.sort();
}

/** An edge key changes (or goes): in the edge list and in what `linkStyle` styles. */
export function rekey(m: Meaning, old: string, next: string | null): void {
	swap(m.edges, old, next);
	m.styled = m.styled.map(s => (s.startsWith(`${old} `) ? (next === null ? '' : next + s.slice(old.length)) : s)).filter(Boolean).sort();
}

/** A group's title changes (or the group goes, its members and children moving to `parent`). */
export function retitle(m: Meaning, old: string, next: string | null, parent = ''): void {
	const to = next ?? parent;
	for (const [id, g] of m.group) if (g === old) m.group.set(id, to);
	m.groups = m.groups.flatMap(x => {
		const [p, t] = [x.slice(0, x.indexOf('>')), x.slice(x.indexOf('>') + 1)];
		if (t === old) return next === null ? [] : [`${p}>${next}`];
		return [`${p === old ? to : p}>${t}`];
	}).sort();
	m.refs = m.refs.map(r => (r.endsWith(`=${old}`) && next !== null ? r.slice(0, r.length - old.length) + next : r)).sort();
}

const show = (m: Map<string, string>) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The first difference between two meanings, in words, or null. */
function difference(a: Meaning, b: Meaning): string | null {
	for (const [what, key] of [['the label of', 'label'], ['the shape of', 'shape'], ['the group of', 'group']] as const) {
		const x = show(a[key]), y = show(b[key]);
		if (x.length !== y.length || x.some(([k], i) => k !== y[i][0])) {
			const gone = x.find(([k]) => !b[key].has(k))?.[0], extra = y.find(([k]) => !a[key].has(k))?.[0];
			return gone ? `the node "${gone}" (it would disappear)` : `a node "${extra}" (it would appear)`;
		}
		const d = x.find(([k, v]) => b[key].get(k) !== v);
		if (d) return `${what} "${d[0]}"`;
	}
	if (a.edges.join('\n') !== b.edges.join('\n')) return 'other links';
	if (a.styled.join('\n') !== b.styled.join('\n')) return 'which link a linkStyle styles';
	if (a.groups.join('\n') !== b.groups.join('\n')) return 'the groups';
	if (a.refs.join('\n') !== b.refs.join('\n')) return 'the group a statement names by its id';
	return null;
}

/**
 * Returns `next` when its meaning is `src`'s changed by `expect`, else refuses. `expect` gets the
 * old meaning (to change in place) and the old scan.
 */
export function checked(src: string, next: string, expect: (m: Meaning, flow: Flow) => void): string {
	if (next === src) return src;
	const before = scanCached(src);
	let after: Flow;
	try {
		after = scanCached(next);
	} catch (e) {
		if (e instanceof ScanError) throw new EditError(`This edit would leave text the editor cannot read (${e.message}), nothing was changed. Edit it in the source.`);
		throw e;
	}
	const want = meaning(before);
	expect(want, before);
	const diff = difference(want, meaning(after));
	if (diff) throw new EditError(`This edit would also change ${diff}, so nothing was changed. Edit it in the source.`);
	return next;
}
