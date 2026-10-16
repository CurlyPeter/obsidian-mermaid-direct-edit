/**
 * A drawing as a file of its own: a standalone SVG or a PNG, from the block text. Used by the
 * CLI (`export`, `export-check`) and by the share button and export dialog (`export-ui.ts`).
 * The parts without a DOM are `export-format.ts`; see CLAUDE.md → "Export".
 *
 * - **Drawn anew** with the plugin's Mermaid through the render hook, like the zoom, so the plugin's
 *   extensions (inertia position, classes, groups) are in the file. With the export config
 *   (`withExportConfig`): labels as SVG text and a portable font.
 * - **Styles frozen.** The drawing is put into a hidden `.mermaid` box under `.theme-light`, and the
 *   computed value of every presentation property is written onto its element: the plugin's rules
 *   (`styles.css`) and the theme's variables exist only inside Obsidian. Obsidian's dark mode is a
 *   filter over the drawing, not other colours, so an export is always the light drawing.
 * - **PNG** rasterises that SVG on a canvas (white unless transparent), within MAX_PIXELS.
 *
 * Node-free like the rest of the plugin (phone): Web Crypto, canvas, Blob.
 */
import type { Mermaid } from 'mermaid';
import { CHECKSUM_ATTR, CHECKSUM_KEY, EXPORT_FONT, ExportFormat, MAX_PIXELS, fitScale, pngSize, pngWithText, portableValue, resolveVars, sha256Hex, withExportConfig } from './export-format';
import { KEY_ATTR, KIND_ATTR, ZOOM_ATTR } from './render';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Render ids of exports; the plugin's after-render step leaves them alone. */
export const EXPORT_ID_PREFIX = 'mde-export-';

/** Inherited presentation properties: written where they differ from the parent's value. */
const INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
	'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
	'letter-spacing', 'visibility'];
/** Properties that are not inherited: written where they differ from their initial value. */
const OWN: [string, string][] = [['opacity', '1'], ['dominant-baseline', 'auto'], ['alignment-baseline', 'auto']];

export interface ExportOptions {
	/** Layout width in px: diagrams that size themselves to their container (gantt, pie) take it. */
	width: number;
	/** PNG only: device pixels per drawing pixel (reduced to stay within MAX_PIXELS). */
	scale: number;
	/** A white ground; else transparent. */
	white: boolean;
}

export interface Exported {
	format: ExportFormat;
	data: string | Uint8Array;
	width: number;
	height: number;
	/** PNG: the scale actually used. */
	scale?: number;
	checksum: string;
}

let renders = 0;

/** A drawing too large for a PNG (MAX_PIXELS even at the smallest scale): the CLI answers `too-large`. */
export class TooLargeError extends Error {}

/**
 * The block text `src` drawn and frozen into a standalone SVG string, its size in px and the
 * text's checksum. Throws Mermaid's message when the text does not draw.
 */
export async function exportSvg(m: Mermaid, src: string, doc: Document, opts: Pick<ExportOptions, 'width' | 'white'>): Promise<Exported & { data: string }> {
	const checksum = await sha256Hex(src);
	// Off screen, not hidden: a hidden ancestor would make every element's computed visibility "hidden".
	const host = doc.body.createDiv({ cls: 'theme-light mde-export-host' });
	host.setCssStyles({ position: 'fixed', left: '-100000px', top: '0', width: `${Math.max(320, Math.round(opts.width))}px`, pointerEvents: 'none' });
	const box = host.createDiv({ cls: 'mermaid' });
	const id = EXPORT_ID_PREFIX + String(++renders);
	try {
		let svg: string;
		try {
			({ svg } = await m.render(id, withExportConfig(src), box));
		} catch (e) {
			doc.getElementById(`d${id}`)?.remove();
			throw e;
		}
		box.insertAdjacentHTML('afterbegin', svg);
		const root = box.querySelector<SVGSVGElement>(':scope > svg');
		if (!root) throw new Error('Mermaid returned no drawing.');
		const { width, height } = sizeOf(root);
		// What only Obsidian means: the plugin's registry keys, Mermaid's max-width for the note. Before
		// the freeze: it writes the root's own style, which every element inherits (the font).
		for (const a of [KEY_ATTR, KIND_ATTR, ZOOM_ATTR, 'style']) root.removeAttribute(a);
		root.setAttribute('width', String(width));
		root.setAttribute('height', String(height));
		// The font on the root as well: some diagram types (wardley-beta) have no style sheet of their
		// own and would inherit Obsidian's font chain (placeholders like '??' included).
		root.style.setProperty('font-family', EXPORT_FONT);
		freezeStyles(root, doc);
		root.setAttribute(CHECKSUM_ATTR, checksum);
		if (opts.white) {
			const vb = root.viewBox.baseVal;
			const ground = doc.createElementNS(SVG_NS, 'rect');
			for (const [k, v] of [['x', vb?.x ?? 0], ['y', vb?.y ?? 0], ['width', vb?.width || width], ['height', vb?.height || height]] as const) ground.setAttribute(k, String(v));
			ground.setAttribute('fill', '#ffffff');
			ground.setAttribute('class', 'mde-export-ground');
			root.insertBefore(ground, root.firstChild);  // first: drawn under everything
		}
		const text = new XMLSerializer().serializeToString(root);
		return { format: 'svg', data: `<?xml version="1.0" encoding="UTF-8"?>\n${text}\n`, width, height, checksum };
	} finally {
		host.remove();
	}
}

/** The drawing's size in px: its viewBox (Mermaid sets one on every diagram type), else its box. */
function sizeOf(root: SVGSVGElement): { width: number; height: number } {
	const vb = root.viewBox.baseVal;
	if (vb && vb.width > 0 && vb.height > 0) return { width: Math.ceil(vb.width), height: Math.ceil(vb.height) };
	const r = root.getBoundingClientRect();
	return { width: Math.max(1, Math.ceil(r.width)), height: Math.max(1, Math.ceil(r.height)) };
}

/**
 * Writes every element's computed presentation values onto it (`style`), and resolves the
 * variables in Mermaid's style sheet: the file must look the same where neither the plugin's
 * rules nor Obsidian's variables exist. HTML inside a `foreignObject` keeps the style sheet.
 */
function freezeStyles(root: SVGSVGElement, doc: Document) {
	const win = doc.defaultView ?? window;
	const computed = new Map<Element, CSSStyleDeclaration>();
	const style = (el: Element) => {
		let cs = computed.get(el);
		if (!cs) computed.set(el, (cs = win.getComputedStyle(el)));
		return cs;
	};
	const writes: [Element, string][] = [];
	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		if (el.namespaceURI !== SVG_NS || el.localName === 'style' || el.localName === 'title' || el.localName === 'desc') continue;
		const cs = style(el);
		const parent = el === root || !el.parentElement ? null : style(el.parentElement);
		const decl: string[] = [];
		for (const p of INHERITED) {
			const v = cs.getPropertyValue(p);
			if (v && portableValue(v) && (!parent || parent.getPropertyValue(p) !== v)) decl.push(`${p}:${v}`);
		}
		for (const [p, initial] of OWN) {
			const v = cs.getPropertyValue(p);
			if (v && portableValue(v) && v !== initial) decl.push(`${p}:${v}`);
		}
		if (cs.getPropertyValue('display') === 'none') decl.push('display:none');
		writes.push([el, decl.join(';')]);
	}
	// Written after every value is read: a write would invalidate the cached computed styles.
	for (const [el, decl] of writes) {
		if (decl) el.setAttribute('style', decl);
		else el.removeAttribute('style');
		el.removeAttribute('cursor');
	}
	// Variables only with their fallback: never a theme value (see resolveVars).
	for (const sheet of Array.from(root.querySelectorAll('style'))) {
		sheet.textContent = resolveVars(sheet.textContent ?? '', () => '');
	}
}

/**
 * The SVG `svg` (from `exportSvg`) as a PNG: `scale` device pixels per drawing pixel (reduced to
 * stay within MAX_PIXELS), on white unless `white` is off, with the checksum in a text chunk.
 */
export async function svgToPng(svg: Exported & { data: string }, doc: Document, scale: number, white: boolean): Promise<Exported & { data: Uint8Array }> {
	const s = fitScale(svg.width, svg.height, scale);
	if (s === null) throw new TooLargeError(`The drawing (${svg.width} x ${svg.height}) is too large for a PNG of at most ${MAX_PIXELS / 1024 / 1024} M pixels; export it as SVG.`);
	const w = Math.max(1, Math.round(svg.width * s)), h = Math.max(1, Math.round(svg.height * s));
	const win = doc.defaultView ?? window;
	const url = win.URL.createObjectURL(new Blob([svg.data], { type: 'image/svg+xml' }));
	try {
		const img = new win.Image();
		img.src = url;
		await img.decode();
		const canvas = doc.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('No canvas available for the PNG.');
		if (white) {
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, w, h);
		}
		ctx.drawImage(img, 0, 0, w, h);
		let blob: Blob | null;
		try {
			blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
		} catch (e) {
			// A canvas the browser considers tainted refuses to give its pixels away.
			throw new Error(`The drawing could not be turned into a PNG here (${e instanceof Error ? e.message : String(e)}); export it as SVG.`);
		}
		if (!blob) throw new Error('The drawing could not be turned into a PNG here; export it as SVG.');
		const png = pngWithText(new Uint8Array(await blob.arrayBuffer()), CHECKSUM_KEY, svg.checksum);
		const size = pngSize(png);
		return { format: 'png', data: png, width: size?.width ?? w, height: size?.height ?? h, scale: s, checksum: svg.checksum };
	} finally {
		win.URL.revokeObjectURL(url);
	}
}

/** The block text `src` as a file of `format`. */
export async function exportDrawing(m: Mermaid, src: string, format: ExportFormat, doc: Document, opts: ExportOptions): Promise<Exported> {
	const svg = await exportSvg(m, src, doc, { width: opts.width, white: format === 'svg' && opts.white });
	return format === 'svg' ? svg : svgToPng(svg, doc, opts.scale, opts.white);
}

/** The MIME type of a format. */
export const mimeOf = (format: ExportFormat) => (format === 'png' ? 'image/png' : 'image/svg+xml');
