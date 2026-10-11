import type { RenderHook } from './render';
import { editBlocker, inertiaPositions } from './wardley-text';

/**
 * Rendering of `wardley-beta` maps: editable unless `editBlocker` refuses (0-100 scale, too
 * large, multi-line accDescr), with the plugin's inertia positions applied.
 */
export const wardleyRender: RenderHook = {
	kind: 'wardley',
	roles: ['wardley'],
	blocker: editBlocker,
	transform: (svg, text) => placeInertia(svg, inertiaPositions(text)),
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
