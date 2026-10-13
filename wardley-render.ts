import type { RenderHook } from './render';
import { END_TOLERANCE, type Pt } from './wardley-geometry';
import { GROUP_BUDGET, GROUP_RADIUS, outline, pathOf, skeleton } from './wardley-groups';
import { CLASS_NAME, MAX_CLASSES, classDefs, classMarkers, editBlocker, groupsOf, inertiaPositions } from './wardley-text';

/**
 * Rendering of `wardley-beta` maps: editable unless `editBlocker` refuses (0-100 scale, too
 * large, multi-line accDescr), with the plugin's inertia positions, classes and groups applied.
 */
export const wardleyRender: RenderHook = {
	kind: 'wardley',
	roles: ['wardley'],
	blocker: editBlocker,
	transform: (svg, text) => {
		let out: string | null = null;
		for (const step of [(s: string) => placeInertia(s, inertiaPositions(text)), (s: string) => applyClasses(s, text), (s: string) => applyGroups(s, text)]) {
			out = step(out ?? svg) ?? out;
		}
		return out;
	},
};

/**
 * An inertia bar as Mermaid 12.1 writes it. Only the numbers in it are replaced: a digit run
 * swapped for a digit run cannot change how the sanitized SVG is parsed, unlike the
 * DOMParser/XMLSerializer round trip this replaced (security review F4).
 */
const BAR = /<line class="wardley-inertia" x1="([-\d.e+]+)"( y1="[-\d.e+]+") x2="([-\d.e+]+)"/g;

/**
 * Moves each inertia bar to the evolution set by `%% mp-inertia` (plugin extension), in the
 * SVG string Mermaid returned. The string is parsed only to read the axis and which component
 * each bar belongs to. Null when there is nothing to move, or when the bars in the string do
 * not match the parsed ones (then Mermaid's own drawing is kept).
 */
export function placeInertia(svgText: string, positions: Map<string, number>): string | null {
	if (positions.size === 0) return null;
	const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
	if (doc.querySelector('parsererror')) return null;
	const [axisX] = Array.from(doc.querySelectorAll('g.wardley-axes > line'));
	if (!axisX) return null;
	const left = Number(axisX.getAttribute('x1')), right = Number(axisX.getAttribute('x2'));
	const xs = Array.from(doc.querySelectorAll('line.wardley-inertia')).map(bar => {
		const name = bar.closest('g.wardley-node')?.querySelector('text.wardley-node-label')?.textContent?.trim() ?? '';
		const evo = positions.get(name);
		return evo === undefined ? null : String(left + Math.min(1, Math.max(0, evo)) * (right - left));
	});
	if (xs.every(x => x === null) || !xs.every(x => x === null || /^[-\d.e+]+$/.test(x))) return null;
	let i = 0;
	const out = svgText.replace(BAR, (bar, x1: string, y1: string, x2: string) => {
		const x = xs[i++];
		return x === null || x === undefined ? bar : `<line class="wardley-inertia" x1="${x}"${y1} x2="${x}"`;
	});
	return i === xs.length ? out : null;
}

type Style = Record<string, string>;
/** Characters `applyClasses` may add to a drawing; over it, Mermaid's drawing is kept. */
const MAX_INSERTED = 256 * 1024;
/** A link's two names in either order. */
const pairKey = ([a, b]: [string, string]) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * A node's group as Mermaid 12.1 writes it (`<g class="wardley-node …">…</g>`, no nested groups)
 * and a link's line. The class must be exactly `wardley-node` or followed by a blank: the
 * container `<g class="wardley-nodes">` would otherwise match too, and its match would swallow
 * the first node while the count still agreed.
 */
const NODE_GROUP = /<g class="wardley-node(?: [^"]*)?">[\s\S]*?<\/g>/g;
const LINK = /<line class="wardley-link(?: [^"]*)?"[^>]*>/g;

/**
 * The nodes and links Mermaid drew, as the editor sees them: a node is named by its label, a link
 * by the nodes its two ends touch (within END_TOLERANCE of their centres, through a grid of
 * END_TOLERANCE cells, so a crafted map with many nodes and links costs one lookup per end).
 */
function readDrawing(doc: Document): { names: string[]; centres: ([number, number] | null)[]; lines: Element[]; ends: () => ([number, number] | null)[] } {
	const nodes = Array.from(doc.querySelectorAll('g.wardley-node'));
	const names = nodes.map(g => Array.from(g.children).find(c => c.localName === 'text' && c.getAttribute('class') === 'wardley-node-label')?.textContent?.trim() ?? '');
	const centres = nodes.map(centreOf);
	const lines = Array.from(doc.querySelectorAll('line.wardley-link'));
	const ends = () => {
		const cell = (x: number, y: number) => `${Math.floor(x / END_TOLERANCE)},${Math.floor(y / END_TOLERANCE)}`;
		const grid = new Map<string, number[]>();
		centres.forEach((c, i) => { if (c) { const k = cell(c[0], c[1]); const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); } });
		const owner = (x: number, y: number): number | null => {
			let best: number | null = null, dist = END_TOLERANCE;
			const cx = Math.floor(x / END_TOLERANCE), cy = Math.floor(y / END_TOLERANCE);
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
						const c = centres[i]!, d = Math.hypot(c[0] - x, c[1] - y);
						if (d <= dist) { best = i; dist = d; }
					}
				}
			}
			return best;
		};
		return lines.map(l => {
			const a = owner(Number(l.getAttribute('x1')), Number(l.getAttribute('y1')));
			const b = owner(Number(l.getAttribute('x2')), Number(l.getAttribute('y2')));
			return a !== null && b !== null ? [a, b] as [number, number] : null;
		});
	};
	return { names, centres, lines, ends };
}

/** Where a drawn node sits: its plain circle, a market node's ring, a pipeline parent's square, an anchor's text. */
function centreOf(g: Element): [number, number] | null {
	const n = (el: Element, a: string) => Number(el.getAttribute(a));
	const kids = Array.from(g.children);
	const circle = kids.find(c => c.localName === 'circle' && !c.getAttribute('class'))
		?? kids.find(c => c.localName === 'circle' && c.getAttribute('class') === 'wardley-market-overlay');
	if (circle) return [n(circle, 'cx'), n(circle, 'cy')];
	const square = kids.find(c => c.localName === 'rect');
	if (square) return [n(square, 'x') + n(square, 'width') / 2, n(square, 'y') + n(square, 'height') / 2];
	// An anchor is drawn as its text alone, 3 px above its position.
	const text = kids.find(c => c.localName === 'text' && c.getAttribute('class') === 'wardley-node-label');
	return text ? [n(text, 'x'), n(text, 'y') + 3] : null;
}

const css = (style: Style, keys: string[]) => keys.filter(k => style[k] !== undefined).map(k => `${k}:${style[k]}`).join(';');
const withStyle = (tag: string, rule: string) => (rule && !/\sstyle="/.test(tag) ? tag.replace(/^<(\w+)/, `<$1 style="${rule}"`) : tag);
const withClasses = (tag: string, classes: string[]) =>
	tag.replace(/class="([^"]*)"/, (_, c: string) => `class="${c} mde-class ${classes.map(k => `mde-class-${k}`).join(' ')}"`);

/** A node's group with its classes, and the `classDef` styles on its shape and its label. */
function classedNode(group: string, classes: string[], style: Style): string {
	const shape = css(style, ['stroke', 'stroke-width', 'stroke-dasharray', 'fill']);
	// The label takes the outline's colour unless the class sets one of its own.
	const labelStyle: Style = { ...style };
	delete labelStyle.fill;
	if (style.color ?? style.stroke) labelStyle.fill = style.color ?? style.stroke;
	const label = css(labelStyle, ['fill', 'font-weight']);
	let first = true;
	return group.replace(/<(g|circle|rect|text)\b[^>]*>/g, (tag, name: string) => {
		if (name === 'g') {
			if (!first) return tag;
			first = false;
			return withClasses(tag, classes);
		}
		const cls = /\sclass="([^"]*)"/.exec(tag)?.[1];
		if (name === 'text') return cls === 'wardley-node-label' ? withStyle(tag, label) : tag;
		if (name === 'circle' && cls !== undefined && cls !== 'wardley-market-overlay') return tag;
		return withStyle(tag, shape);
	});
}

/**
 * Applies the plugin's `%% class` lines (DEV.md → "Classes for wardley-beta") to the SVG string
 * Mermaid returned: the node's group or the link's line gets `mde-class mde-class-<name>`, which
 * `styles.css` draws for `highlight`, and a `%% classDef` of that class adds its (checked)
 * properties as inline style. Elements are named by their label, links by the two nodes their
 * ends touch, the way the editor finds them. Like `placeInertia`, the string is parsed only to
 * read; it is changed by inserting attribute text, never re-serialized. Null when nothing applies
 * or when the string's tags do not match the parsed ones (then Mermaid's drawing is kept).
 */
export function applyClasses(svgText: string, source: string): string | null {
	const marks = classMarkers(source).filter(m => !m.problem);
	if (marks.length === 0) return null;
	const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
	if (doc.querySelector('parsererror')) return null;
	const { names, centres, lines, ends } = readDrawing(doc);
	// Lookups by name and by pair: class lines are comments, which Mermaid's size limit does not
	// count, so a crafted note can hold many; each target costs one lookup, not a scan.
	const index = (map: Map<string, number[]>, key: string, i: number) => { const l = map.get(key); if (l) l.push(i); else map.set(key, [i]); };
	const byName = new Map<string, number[]>();
	names.forEach((n, i) => index(byName, n, i));
	const byPair = new Map<string, number[]>();
	if (marks.some(m => m.targets.some(t => typeof t !== 'string'))) {
		ends().forEach((e, i) => { if (e) index(byPair, pairKey([names[e[0]], names[e[1]]]), i); });
	}
	// At most MAX_CLASSES per element: a link drawn many times (duplicates are each drawn) times
	// many classes made the drawing hundreds of MB (security review 0.19.0).
	const nodeClasses = centres.map(() => new Set<string>());
	const linkClasses = lines.map(() => new Set<string>());
	const add = (set: Set<string>, cls: string) => { if (set.size < MAX_CLASSES) set.add(cls); };
	for (const m of marks) {
		for (const t of m.targets) {
			if (typeof t === 'string') for (const i of byName.get(t) ?? []) add(nodeClasses[i], m.cls);
			else for (const i of byPair.get(pairKey(t)) ?? []) add(linkClasses[i], m.cls);
		}
	}
	if (nodeClasses.every(c => !c.size) && linkClasses.every(c => !c.size)) return null;
	const defs = new Map<string, Style>();
	for (const d of classDefs(source)) if (CLASS_NAME.test(d.name)) defs.set(d.name, { ...defs.get(d.name), ...d.style });
	const styleOf = (classes: string[]): Style => {
		const style: Style = {};
		for (const c of classes) Object.assign(style, defs.get(c));
		return style;
	};
	// What the plugin inserts stays small next to Mermaid's drawing; beyond that, Mermaid's own.
	let budget = MAX_INSERTED;
	const insert = (before: string, after: string) => { budget -= after.length - before.length; return after; };
	let n = 0;
	let out = svgText.replace(NODE_GROUP, group => {
		const classes = [...(nodeClasses[n++] ?? [])];
		return classes.length && budget > 0 ? insert(group, classedNode(group, classes, styleOf(classes))) : group;
	});
	if (n !== names.length) return null;
	let k = 0;
	out = out.replace(LINK, tag => {
		const classes = [...(linkClasses[k++] ?? [])];
		return classes.length && budget > 0
			? insert(tag, withStyle(withClasses(tag, classes), css(styleOf(classes), ['stroke', 'stroke-width', 'stroke-dasharray'])))
			: tag;
	});
	return k === lines.length && budget >= 0 ? out : null;
}

/** Groups drawn per map, and members per group (crafted maps). */
const MAX_GROUPS = 20;
const MAX_GROUP_MEMBERS = 100;
/** Where the boundaries go: behind pipelines, links and nodes, above the stages and grid. */
const GROUPS_BEFORE = ['<g class="wardley-pipelines">', '<g class="wardley-links">', '<g class="wardley-nodes">'];

/**
 * Draws each `%% group` (DEV.md → "Groups for wardley-beta") as a dotted boundary around its
 * members and the links between them (`wardley-groups.ts`). The boundaries are inserted as one
 * new `<g class="mde-groups">` of paths built from numbers only, behind pipelines, links and
 * nodes; nothing else in the string changes and no note text is written into it. Members are
 * found by label. A group with no drawn member, or over the limits, is not drawn; null when no
 * group is.
 */
export function applyGroups(svgText: string, source: string): string | null {
	const groups = groupsOf(source);
	if (groups.length === 0) return null;
	const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
	if (doc.querySelector('parsererror')) return null;
	const { names, centres, ends } = readDrawing(doc);
	const byName = new Map<string, number[]>();
	names.forEach((n, i) => { const l = byName.get(n); if (l) l.push(i); else byName.set(n, [i]); });
	let linkEnds: ([number, number] | null)[] | null = null;
	const budget = { left: GROUP_BUDGET };
	const paths: string[] = [];
	let size = 0;
	groups.slice(0, MAX_GROUPS).forEach((g, gi) => {
		const nodes = [...new Set(g.members.flatMap(m => byName.get(m) ?? []))].filter(i => centres[i]);
		if (nodes.length === 0 || nodes.length > MAX_GROUP_MEMBERS) return;
		const at = new Map(nodes.map((n, k) => [n, k]));
		const points: Pt[] = nodes.map(i => ({ x: centres[i]![0], y: centres[i]![1] }));
		linkEnds ??= ends();
		const links: [number, number][] = [];
		for (const e of linkEnds) if (e && at.has(e[0]) && at.has(e[1])) links.push([at.get(e[0])!, at.get(e[1])!]);
		const loops = outline(skeleton(points, links), GROUP_RADIUS, budget);
		if (!loops?.length) return;
		const path = `<path class="mde-group" data-mde-group="${gi}" d="${pathOf(loops)}" fill="none" stroke="#888888" stroke-width="1.5" stroke-dasharray="3 3" pointer-events="none"></path>`;
		// What the plugin inserts stays small next to Mermaid's drawing: a group over it is skipped.
		if (size + path.length > MAX_INSERTED) return;
		size += path.length;
		paths.push(path);
	});
	if (paths.length === 0) return null;
	const inserted = `<g class="mde-groups">${paths.join('')}</g>`;
	const at = GROUPS_BEFORE.map(m => svgText.indexOf(m)).find(i => i >= 0) ?? -1;
	if (at < 0) return null;
	return svgText.slice(0, at) + inserted + svgText.slice(at);
}
