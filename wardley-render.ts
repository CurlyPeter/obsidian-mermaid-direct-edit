import type { Mermaid, RenderResult } from 'mermaid';
import { editBlocker, inertiaPositions } from './wardley-text';

/** Attribute on a rendered wardley SVG that points to its source in the registry. */
export const KEY_ATTR = 'data-mp-src';

/**
 * The exact source text of every editable wardley SVG this plugin instance rendered, by key.
 * Keys carry a per-instance prefix: a map drawn before a plugin reload keeps its old key, and
 * a plain counter restarting at 1 would hand it another map's source (review finding #2).
 * Identical text shares one key, and each source is at most MAX_SOURCE long (`editBlocker`),
 * so redraws do not pile up copies (security review F6).
 */
export class SourceRegistry {
	private sources = new Map<string, string>();
	private keys = new Map<string, string>();
	private next = 0;
	private readonly prefix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-`;

	register(text: string): string {
		const known = this.keys.get(text);
		if (known) {
			// most recently used last, so eviction takes the oldest
			this.sources.delete(known);
			this.sources.set(known, text);
			return known;
		}
		const key = this.prefix + String(++this.next);
		this.sources.set(key, text);
		this.keys.set(text, key);
		if (this.sources.size > 200) {
			const [oldKey, oldText] = this.sources.entries().next().value as [string, string];
			this.sources.delete(oldKey);
			this.keys.delete(oldText);
		}
		return key;
	}

	sourceOf(svg: Element): string | undefined {
		return this.sources.get(svg.getAttribute(KEY_ATTR) ?? '');
	}
}

/**
 * Wraps `render` so each editable wardley SVG carries its source key, and applies the plugin's
 * inertia positions. A map `editBlocker` refuses (0-100 scale, too large, multi-line
 * accDescr) stays untagged: it renders, but the editor leaves it alone.
 */
export function wrapRender(m: Mermaid, registry: SourceRegistry) {
	const render = m.render.bind(m);
	m.render = async (id: string, text: string, container?: Element): Promise<RenderResult> => {
		const r = await render(id, text, container);
		if (!r.svg.includes('aria-roledescription="wardley"')) return r;
		const svg = placeInertia(r.svg, inertiaPositions(text)) ?? r.svg;
		if (editBlocker(text)) return { ...r, svg };
		return { ...r, svg: svg.replace('<svg ', `<svg ${KEY_ATTR}="${registry.register(text)}" `) };
	};
}

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
