/**
 * Export of a drawing as a standalone SVG or PNG: the parts without a DOM (unit-tested). The
 * drawing, its styles and the raster are `export.ts`; see CLAUDE.md → "Export".
 *
 * Every exported file carries the SHA-256 of the block text it was drawn from: an SVG on its root
 * element, a PNG in a text chunk. `export-check` compares it with the note's blocks, so a build can
 * tell a current export from a stale one. Only the checksum: a note path would travel with every
 * file shared by mail or uploaded somewhere.
 */

export type ExportFormat = 'png' | 'svg';

/** Root attribute of an exported SVG: the SHA-256 (hex) of its block text. */
export const CHECKSUM_ATTR = 'data-mde-source-sha256';
/** Keyword of the PNG text chunk holding the same checksum. */
export const CHECKSUM_KEY = 'mde-source-sha256';

/** A font every tool that opens the file has, so text measured while drawing fits in Affinity, Miro or a mail. */
export const EXPORT_FONT = 'Helvetica, Arial, sans-serif';

/**
 * Mermaid config for an export: labels as SVG text (HTML labels sit in `foreignObject`, which
 * Affinity, Miro, mail clients and librsvg do not show) and the portable font. Appended as a
 * directive, so it wins over the diagram's own config and the instance's stays untouched. The font
 * goes in as top-level `fontFamily`: `themeVariables.fontFamily` in a directive drops the font from
 * Mermaid's style sheet altogether (measured on 12.1.0).
 */
const EXPORT_INIT = `%%{init: ${JSON.stringify({ htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: EXPORT_FONT })}}%%`;

/** The block text as drawn for an export. Mermaid removes directives before any diagram parser sees the text. */
export const withExportConfig = (src: string) => `${src}\n${EXPORT_INIT}`;

/** Largest PNG in pixels: iOS refuses larger canvases (16.7 M), and a crafted map must not take the memory. */
export const MAX_PIXELS = 4096 * 4096;
/** Longest side of a PNG in pixels (canvas limits). */
export const MAX_SIDE = 16384;
/** Scales a caller may ask for. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

/** SHA-256 of `text` (UTF-8) as lower-case hex. Web Crypto: present on desktop, phone and in Node. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The scale a PNG of `width` x `height` gets: the one asked for, reduced (two decimals) until the
 * image stays within MAX_PIXELS and MAX_SIDE; null when even MIN_SCALE would not (a drawing that
 * large goes out as SVG only). No floor: a floor let a crafted `size` through (security review
 * 0.25.0, O79).
 */
export function fitScale(width: number, height: number, scale: number): number | null {
	const w = Math.max(1, width), h = Math.max(1, height);
	const max = Math.min(Math.sqrt(MAX_PIXELS / (w * h)), MAX_SIDE / w, MAX_SIDE / h);
	const s = Math.floor(Math.min(scale, max) * 100) / 100;
	return s >= MIN_SCALE ? s : null;
}

/**
 * The vault path an export may be written to, and its format from the extension, or an error
 * message. Vault-relative only: no absolute path, no `..` or `.` segment, no hidden folder (the
 * config folder among them: a write there could plant plugin code), `.png` or `.svg` only.
 */
export function checkOutPath(out: string): { path: string; format: ExportFormat } | string {
	const path = out.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	if (!path) return 'out= is required: the vault path of the file to write (.png or .svg).';
	// Control characters (the NUL a path cannot hold among them); a loop, no regex over the whole text.
	for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) < 32) return 'out= holds a control character.';
	if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return `out=${out}: a path inside the vault, not an absolute one.`;
	// Characters Obsidian refuses in file names; a ':' also never syncs to iOS and is an NTFS stream.
	if (/[*"<>:|?]/.test(path)) return `out=${out}: no * " < > : | ? in the path.`;
	const parts = path.split('/');
	if (parts.some(p => p === '' || p === '.' || p === '..')) return `out=${out}: no empty, "." or ".." parts.`;
	if (parts.some(p => p.startsWith('.'))) return `out=${out}: not into a hidden folder or file (the config folder among them).`;
	const ext = /\.(png|svg)$/i.exec(path);
	if (!ext) return `out=${out}: the file must end in .png or .svg.`;
	return { path, format: ext[1].toLowerCase() as ExportFormat };
}

/** File name of a drawing saved next to its note: the note's name and the diagram's number in it. */
export const savedName = (noteBasename: string, block: number) => `${noteBasename} ${block}`;

/** The checksum on the root element of an exported SVG, or null. Only the root tag is read. */
export function svgChecksum(svg: string): string | null {
	const start = svg.indexOf('<svg');
	if (start < 0) return null;
	const end = svg.indexOf('>', start);
	if (end < 0) return null;
	const m = new RegExp(`\\s${CHECKSUM_ATTR}="([0-9a-f]{64})"`).exec(svg.slice(start, end));
	return m ? m[1] : null;
}

// ---- PNG ----------------------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

const isPng = (png: Uint8Array) => png.length >= 33 && PNG_SIGNATURE.every((b, i) => png[i] === b);

/** Width and height from a PNG's header, or null when it is not one. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
	if (!isPng(png)) return null;
	const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** `png` with a `tEXt` chunk `key` = `text` (Latin-1) right after its header chunk. */
export function pngWithText(png: Uint8Array, key: string, text: string): Uint8Array {
	if (!isPng(png)) throw new Error('not a PNG');
	const body = new TextEncoder().encode(`${key}\0${text}`);
	const chunk = new Uint8Array(12 + body.length);
	const v = new DataView(chunk.buffer);
	v.setUint32(0, body.length);
	chunk.set([116, 69, 88, 116], 4);  // "tEXt"
	chunk.set(body, 8);
	v.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
	// The header chunk (IHDR) is always first and 13 bytes long: signature 8 + length 4 + type 4 + 13 + CRC 4.
	const at = 33;
	const out = new Uint8Array(png.length + chunk.length);
	out.set(png.subarray(0, at), 0);
	out.set(chunk, at);
	out.set(png.subarray(at), at + chunk.length);
	return out;
}

/** The text of the PNG's `tEXt` chunk `key`, or null. Walks the chunk list once, up to the image data. */
export function pngText(png: Uint8Array, key: string): string | null {
	if (!isPng(png)) return null;
	const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const want = new TextEncoder().encode(`${key}\0`);
	let at = 8;
	while (at + 12 <= png.length) {
		const len = v.getUint32(at);
		const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
		if (type === 'IDAT' || type === 'IEND' || at + 12 + len > png.length) return null;
		if (type === 'tEXt' && len >= want.length && want.every((b, i) => png[at + 8 + i] === b)) {
			return new TextDecoder('latin1').decode(png.subarray(at + 8 + want.length, at + 8 + len));
		}
		at += 12 + len;
	}
	return null;
}

/**
 * Whether a frozen style value may go into the file: a `url()` only as a reference inside the
 * drawing (`url(#id)`, gradients and markers), never to anything outside it.
 */
export const portableValue = (v: string) => !v.includes('url(') || /^url\(\s*["']?#[^)]*\)$/.test(v.trim());

/** The checksum an exported file carries (SVG text or PNG bytes), or null. */
export function fileChecksum(format: ExportFormat, data: string | Uint8Array): string | null {
	if (format === 'svg') return svgChecksum(typeof data === 'string' ? data : new TextDecoder().decode(data));
	const text = typeof data === 'string' ? null : pngText(data, CHECKSUM_KEY);
	return text && /^[0-9a-f]{64}$/.test(text) ? text : null;
}

/**
 * `css` with every `var(--name)` / `var(--name, fallback)` replaced by `value(name)` (or the
 * fallback as written when that is empty): no variable exists outside Obsidian. The export passes
 * no values at all, so a note's `classDef` cannot copy a theme value into a file that is mailed
 * (security review 0.25.0, I-3); what the variables did is in the frozen element styles. One pass
 * that never looks at a fallback again, so it stays linear on crafted nesting.
 */
export function resolveVars(css: string, value: (name: string) => string): string {
	let out = '';
	let i = 0;
	while (i < css.length) {
		const at = css.indexOf('var(', i);
		if (at < 0) { out += css.slice(i); break; }
		out += css.slice(i, at);
		let depth = 1, j = at + 4;
		while (j < css.length && depth > 0) {
			if (css[j] === '(') depth++;
			else if (css[j] === ')') depth--;
			j++;
		}
		if (depth > 0) { out += css.slice(at); break; }  // unbalanced: left as it is
		const inner = css.slice(at + 4, j - 1);
		const comma = inner.indexOf(',');
		const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
		const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
		const v = name.startsWith('--') ? value(name).trim() : '';
		out += v || fallback;
		i = j;
	}
	return out;
}
