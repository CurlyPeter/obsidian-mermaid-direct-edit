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
const EXPORT_CONFIG = { htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: EXPORT_FONT };
const EXPORT_INIT = `%%{init: ${JSON.stringify(EXPORT_CONFIG)}}%%`;

/** The block text as drawn for an export. Mermaid removes directives before any diagram parser sees the text. */
export const withExportConfig = (src: string) => `${src}\n${EXPORT_INIT}`;

/**
 * Whether `config`, the config Mermaid reports it will draw with (`mermaid.parse(text).config`),
 * holds every value of the export's directive. One unreadable `%%{…}%%` directive makes Mermaid
 * ignore every directive, this one too, and frontmatter alone can set some of its keys
 * (`htmlLabels: false` while `flowchart.htmlLabels` stays true draws flowchart labels as HTML), so
 * all of them are compared.
 */
export function exportConfigApplied(config: unknown): boolean {
	const holds = (want: Record<string, unknown>, got: unknown): boolean => typeof got === 'object' && got !== null
		&& Object.entries(want).every(([k, v]) => (typeof v === 'object' && v !== null
			? holds(v as Record<string, unknown>, (got as Record<string, unknown>)[k])
			: (got as Record<string, unknown>)[k] === v));
	return holds(EXPORT_CONFIG, config);
}

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

/**
 * Names of functions that take a URL, as `url()` or as a string (`image-set("…")`), vendor prefixes
 * included. A name `url` followed by `(` is read apart (its argument decides); this list also catches
 * it where CSS reads no function at all: as a number's unit (`1url(`) or a hash (`#url(`). Those
 * fetch nothing in any engine, and are dropped anyway on purpose: nothing legitimate looks like that.
 */
const URL_TAKING = /(?:^|-)(?:url|src|image|image-set|cross-fade|element|attr)$/;
/**
 * CSS Syntax 3's non-ASCII ident code points. Every engine reads them as part of a name; any other
 * non-ASCII character is a name character to engines that follow the older rule and a separate
 * token to those that follow the newer one, so a rule holding one outside strings, URLs and
 * comments is dropped (it could end a name where one engine sees `url(` and the other does not).
 */
const identCode = (n: number) => n === 0xb7 || (n >= 0xc0 && n <= 0xd6) || (n >= 0xd8 && n <= 0xf6) || (n >= 0xf8 && n <= 0x37d)
	|| (n >= 0x37f && n <= 0x1fff) || n === 0x200c || n === 0x200d || n === 0x203f || n === 0x2040 || (n >= 0x2070 && n <= 0x218f)
	|| (n >= 0x2c00 && n <= 0x2fef) || (n >= 0x3001 && n <= 0xd7ff) || (n >= 0xf900 && n <= 0xfdcf) || (n >= 0xfdf0 && n <= 0xfffd) || n >= 0x10000;
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
const isNameStart = (c: string | undefined) => c !== undefined && (/^[A-Za-z_]$/.test(c) || c >= '\u0080');
const isNameChar = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === '-';
const isEscape = (s: string, i: number) => s[i] === '\\' && s[i + 1] !== '\n';
const startsName = (s: string, i: number) =>
	s[i] === '-' ? isNameStart(s[i + 1]) || s[i + 1] === '-' || isEscape(s, i + 1) : isNameStart(s[i]) || isEscape(s, i);
const startsNumber = (s: string, i: number) =>
	s[i] === '+' || s[i] === '-' ? isDigit(s[i + 1]) || (s[i + 1] === '.' && isDigit(s[i + 2])) : s[i] === '.' ? isDigit(s[i + 1]) : isDigit(s[i]);
const nonPrintable = (c: string) => { const n = c.charCodeAt(0); return n <= 8 || n === 11 || (n >= 14 && n <= 31) || n === 127; };

/** The escape starting at `s[i]` (a backslash): the character it stands for and where it ends. */
function cssEscape(s: string, i: number): { ch: string; end: number } {
	let j = i + 1;
	if (j >= s.length) return { ch: '\uFFFD', end: j };
	if (!isHex(s[j])) return { ch: s[j], end: j + 1 };
	const from = j;
	while (j < s.length && j - from < 6 && isHex(s[j])) j++;
	const cp = parseInt(s.slice(from, j), 16);
	if (isSpace(s[j])) j++;
	return { ch: cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp), end: j };
}

/** The name starting at `s[i]`, escapes decoded, ASCII lower case; `odd` when it holds, as written, a non-ASCII character outside `identCode`. */
function cssName(s: string, i: number): { value: string; end: number; odd: boolean } {
	let value = '', odd = false;
	while (i < s.length) {
		if (s[i] >= '\u0080') {
			const cp = s.codePointAt(i) ?? 0xfffd;
			odd ||= !identCode(cp);
			const n = cp > 0xffff ? 2 : 1;
			value += s.slice(i, i + n);
			i += n;
		} else if (isNameChar(s[i])) value += s[i++];
		else if (isEscape(s, i)) { const e = cssEscape(s, i); value += e.ch; i = e.end; }
		else break;
	}
	return { value: value.replace(/[A-Z]/g, c => c.toLowerCase()), end: i, odd };
}

/** The string whose quote is `s[i]`, decoded. Ends at its quote, before a line break (CSS drops such a string) or at the end. */
function cssString(s: string, i: number): { value: string; end: number } {
	const quote = s[i];
	let value = '', j = i + 1;
	while (j < s.length) {
		const c = s[j];
		if (c === quote) return { value, end: j + 1 };
		if (c === '\n') return { value, end: j };
		if (c !== '\\') { value += c; j++; }
		else if (j + 1 >= s.length) j++;
		else if (s[j + 1] === '\n') j += 2;
		else { const e = cssEscape(s, j); value += e.ch; j = e.end; }
	}
	return { value, end: j };
}

/** An unquoted `url(` token from `s[i]` (just after the parenthesis): its value, or null where CSS reads a bad URL. */
function cssUrl(s: string, i: number): { value: string | null; end: number } {
	while (isSpace(s[i])) i++;
	let value = '';
	for (;;) {
		if (i >= s.length) return { value, end: i };
		const c = s[i];
		if (c === ')') return { value, end: i + 1 };
		if (isSpace(c)) {
			while (isSpace(s[i])) i++;
			if (i >= s.length) return { value, end: i };
			if (s[i] === ')') return { value, end: i + 1 };
			break;
		}
		if (c === '"' || c === "'" || c === '(' || nonPrintable(c) || (c === '\\' && !isEscape(s, i))) break;
		if (c === '\\') { const e = cssEscape(s, i); value += e.ch; i = e.end; }
		else { value += c; i++; }
	}
	// A bad URL: CSS skips to the next `)` that is not escaped.
	while (i < s.length && s[i] !== ')') i = isEscape(s, i) ? cssEscape(s, i).end : i + 1;
	return { value: null, end: Math.min(s.length, i + 1) };
}

/**
 * The drawing's style sheet `css` without each top-level rule that would fetch something outside
 * the file: `@import`, `@font-face`, a `url()` other than `url(#id)`, or a function that takes a URL
 * as a string (`image-set`, `src`, `cross-fade`, …). A note reaches this sheet (`themeCSS`,
 * `classDef`), and a browser that opens the file fetches what it names (security review 0.29.0).
 *
 * Read the way CSS tokenizes (comments, strings, escapes, numbers with units, unquoted `url(`), so
 * `\75 rl(` is the function it spells and a string or comment cannot hide a rule from this scan but
 * not from a browser. A rule ends at a `;` or `}` back at the top level, so every kept rule starts
 * and ends between tokens and is read the same in the file. A rule goes too where engines read the
 * text differently: a non-ASCII character outside strings, URLs and comments that is not an ident
 * code point (`identCode`), and `u+…` (a unicode range to some). Mermaid's own rules have none of
 * this (a `classDef grün` keeps its rule); the frozen element styles keep the look of whatever a
 * dropped rule set. One pass, linear.
 */
export function portableSheet(css: string): string {
	const s = css.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\uFFFD');
	let out = '', start = 0, depth = 0, foreign = false, i = 0;
	const cut = (at: number) => {
		if (!foreign) out += s.slice(start, at);
		start = at;
		foreign = false;
	};
	while (i < s.length) {
		const c = s[i];
		if (c === '/' && s[i + 1] === '*') {
			const close = s.indexOf('*/', i + 2);
			i = close < 0 ? s.length : close + 2;
		} else if (c === '"' || c === "'") {
			i = cssString(s, i).end;
		} else if (c === '#' && (isNameChar(s[i + 1]) || isEscape(s, i + 1))) {
			const name = cssName(s, i + 1);
			foreign ||= name.odd || (s[name.end] === '(' && URL_TAKING.test(name.value));  // `#url(`: over-blocking, see URL_TAKING
			i = name.end;
		} else if (c === '@' && startsName(s, i + 1)) {
			const name = cssName(s, i + 1);
			foreign ||= name.odd || name.value === 'import' || name.value === 'font-face';
			i = name.end;
		} else if (c === '<' && s.startsWith('!--', i + 1)) {
			i += 4;
		} else if (startsNumber(s, i)) {
			if (s[i] === '+' || s[i] === '-') i++;
			while (isDigit(s[i])) i++;
			if (s[i] === '.' && isDigit(s[i + 1])) { i++; while (isDigit(s[i])) i++; }
			if ((s[i] === 'e' || s[i] === 'E') && (isDigit(s[i + 1]) || ((s[i + 1] === '+' || s[i + 1] === '-') && isDigit(s[i + 2])))) {
				i += 2;
				while (isDigit(s[i])) i++;
			}
			if (startsName(s, i)) {
				const unit = cssName(s, i);
				foreign ||= unit.odd || (s[unit.end] === '(' && URL_TAKING.test(unit.value));  // `1url(`: over-blocking, see URL_TAKING
				i = unit.end;
			}
			else if (s[i] === '%') i++;
		} else if (c === '-' && s[i + 1] === '-' && s[i + 2] === '>') {
			i += 3;
		} else if (startsName(s, i)) {
			const name = cssName(s, i);
			// `u+…`: an engine that still tokenizes unicode ranges ends that token elsewhere than a number.
			foreign ||= name.odd || (name.value === 'u' && s[name.end] === '+');
			i = name.end;
			if (s[i] !== '(') continue;
			i++;
			if (name.value === 'url') {
				while (isSpace(s[i]) && isSpace(s[i + 1])) i++;
				const q = isSpace(s[i]) ? i + 1 : i;
				if (s[q] === '"' || s[q] === "'") {
					const str = cssString(s, q);
					foreign ||= !str.value.startsWith('#');
					i = str.end;
				} else {
					const url = cssUrl(s, i);
					foreign ||= url.value === null || !url.value.startsWith('#');
					i = url.end;
				}
			} else foreign ||= URL_TAKING.test(name.value);
		} else {
			i++;
			if (c === '{') depth++;
			// A stray `}` at the top level is part of the rule being read (CSS takes it into its prelude):
			// no cut there. A cut before it would let the text in front of it run into the next kept rule
			// once the rule between is dropped, and two tokens merge (`@impor` and `t "…"`: `@import "…"`).
			// Every cut is right after a `;` or `}`, which no token can run into.
			else if (c === '}') { if (depth > 0) { depth--; if (depth === 0) cut(i); } }
			else if (c === ';' && depth === 0) cut(i);
		}
	}
	cut(s.length);
	return out;
}

/** Attributes through which an element loads something: `href` covers `xlink:href` (pass the local name). */
const LOADING = new Set(['src', 'srcset', 'imagesrcset', 'srcdoc', 'poster', 'data', 'background', 'href', 'lowsrc', 'dynsrc', 'codebase', 'archive', 'classid', 'manifest', 'ping']);
/** Presentation attributes that take a CSS value with a `url()`. */
const CSS_URL = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
/** Where a `data:` URL is drawn as a picture, which loads nothing further; anywhere else it may be a document that does. */
const DATA_IMAGE = new Set(['img src', 'image href', 'feimage href', 'input src', 'video poster']);
/** Elements that run code or load a document of their own. */
const ACTIVE = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'portal']);
const ANIMATION = new Set(['animate', 'set', 'animatemotion', 'animatetransform', 'animatecolor']);

/** Where an attribute sits, for `portableAttribute`. */
export interface AttributeContext {
	/**
	 * The attribute is in no namespace. An HTML element in a label keeps `xlink:href` or `xmlns` as a
	 * plain attribute, which the serializer writes as it is: read back as XML, it is a real one.
	 */
	plain: boolean;
	/**
	 * The element is Mermaid's image shape (`A@{ img: … }`): an `<image>` whose parent `<g>` has the
	 * class `image-shape`, outside any `foreignObject`. Mermaid sets that class on the shape's group;
	 * a diagram's own class lands elsewhere (a sequence participant's on its rect).
	 */
	imageShape: boolean;
}

/**
 * What an exported file keeps of the attribute `name` (the local name of a namespaced attribute, the
 * whole name of a plain one) = `value` on element `tag`: the value, a cleaned value, or null to drop
 * it. Nothing that loads when the file is opened stays: handlers, `srcdoc`, `srcset`, a loading
 * attribute whose value is not `#…` (a `data:` picture only where it is drawn as one), a `style` or
 * presentation value naming an outside URL, a plain attribute with a prefix or named `xmlns`.
 * `<a href>` stays, a link fetches only when followed. So does the `href` of Mermaid's image shape,
 * a picture the diagram itself draws, kept until that is decided (DEV.md 0.29.0); any other
 * `<image>` (a sequence participant's `icon`, an `<image>` in a label) loses it.
 */
export function portableAttribute(tag: string, name: string, value: string, at: AttributeContext): string | null {
	const t = tag.toLowerCase(), n = name.toLowerCase();
	if (at.plain && (n.includes(':') || n === 'xmlns')) return null;
	if (n.startsWith('on') || n === 'srcdoc' || n === 'srcset' || n === 'imagesrcset') return null;
	if (n === 'style') return portableSheet(value);
	if (CSS_URL.has(n)) return portableSheet(value) === value ? value : null;
	if (!LOADING.has(n)) return value;
	if (n === 'href' && (t === 'a' || (t === 'image' && at.imageShape))) return value;
	const v = value.trim();
	if (v.startsWith('#') || (/^data:/i.test(v) && DATA_IMAGE.has(`${t} ${n}`))) return value;
	return null;
}

/**
 * Whether element `tag` (its qualified name) may stay in an exported file: not one that runs code or
 * loads a document, no `<template>` (its content is not part of the document the pass walks, and
 * read back as XML it is), no name with a prefix (`svg:image` in a label is an HTML element in the
 * DOM and a real SVG image once the file is read as XML), and no animation that sets a loading or
 * URL-taking attribute (`<set attributeName="href" to=…>` loads the moment the file is shown).
 * `attributeName` is the animation's, when it has one.
 */
export function portableElement(tag: string, attributeName: string | null): boolean {
	const t = tag.toLowerCase();
	if (ACTIVE.has(t) || t === 'template' || t.includes(':')) return false;
	if (!ANIMATION.has(t) || attributeName === null) return true;
	const n = attributeName.toLowerCase().replace(/^xlink:/, '');
	return !LOADING.has(n) && !CSS_URL.has(n) && n !== 'style';
}

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
