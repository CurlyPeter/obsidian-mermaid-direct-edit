// @vitest-environment happy-dom
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import mermaid from 'mermaid';
import { describe, expect, it } from 'vitest';
import { AttributeContext, CHECKSUM_ATTR, CHECKSUM_KEY, EXPORT_FONT, MAX_PIXELS, MAX_SIDE, checkOutPath, exportConfigApplied, fileChecksum, fitScale, pngSize, pngText, pngWithText, portableAttribute, portableElement, portableSheet, portableValue, resolveVars, savedName, sha256Hex, svgChecksum, withExportConfig } from './export-format';
import { timeLimit } from './test-timing';

/** A real 2x1 PNG built with zlib (independent of the code under test): signature, IHDR, IDAT, IEND. */
function tinyPng(): Uint8Array {
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length);
		const v = new DataView(out.buffer);
		v.setUint32(0, data.length);
		out.set(new TextEncoder().encode(type), 4);
		out.set(data, 8);
		v.setUint32(8 + data.length, zlibCrc32(out.subarray(4, 8 + data.length)));
		return out;
	};
	const ihdr = new Uint8Array(13);
	new DataView(ihdr.buffer).setUint32(0, 2);
	new DataView(ihdr.buffer).setUint32(4, 1);
	ihdr.set([8, 6, 0, 0, 0], 8);  // 8 bit, RGBA
	const raw = new Uint8Array([0, 255, 0, 0, 255, 0, 0, 255, 255]);  // filter byte + two pixels
	const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
}

/** Every chunk of a PNG with its CRC checked by zlib's own crc32. */
function chunks(png: Uint8Array): { type: string; crcOk: boolean }[] {
	const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const out: { type: string; crcOk: boolean }[] = [];
	for (let at = 8; at < png.length;) {
		const len = v.getUint32(at);
		const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
		out.push({ type, crcOk: v.getUint32(at + 8 + len) === zlibCrc32(png.subarray(at + 4, at + 8 + len)) });
		at += 12 + len;
	}
	return out;
}

const HASH = 'a'.repeat(64);

describe('checksum', () => {
	it('is the SHA-256 of the block text', async () => {
		expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(await sha256Hex('flowchart LR\nA-->B')).not.toBe(await sha256Hex('flowchart LR\nA-->C'));
	});

	it('is read from the root element of an SVG only', () => {
		expect(svgChecksum(`<svg id="x" ${CHECKSUM_ATTR}="${HASH}" viewBox="0 0 1 1"><g/></svg>`)).toBe(HASH);
		expect(svgChecksum(`<svg id="x"><text ${CHECKSUM_ATTR}="${HASH}"/></svg>`)).toBeNull();
		expect(svgChecksum(`<svg ${CHECKSUM_ATTR}="short"></svg>`)).toBeNull();
		expect(svgChecksum('no svg')).toBeNull();
	});
});

describe('PNG text chunk', () => {
	it('goes right after the header, every CRC valid, the image unchanged', () => {
		const png = tinyPng();
		const out = pngWithText(png, CHECKSUM_KEY, HASH);
		expect(chunks(out).map(c => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
		expect(chunks(out).every(c => c.crcOk)).toBe(true);
		expect(pngText(out, CHECKSUM_KEY)).toBe(HASH);
		expect(pngSize(out)).toEqual({ width: 2, height: 1 });
		expect(fileChecksum('png', out)).toBe(HASH);
	});

	it('is absent from a plain PNG and from what is not one', () => {
		expect(pngText(tinyPng(), CHECKSUM_KEY)).toBeNull();
		expect(fileChecksum('png', tinyPng())).toBeNull();
		expect(pngText(new TextEncoder().encode('<svg/>'), CHECKSUM_KEY)).toBeNull();
		expect(() => pngWithText(new Uint8Array(40), CHECKSUM_KEY, HASH)).toThrow();
	});

	it('another key does not answer, and a truncated file ends the walk', () => {
		const out = pngWithText(tinyPng(), 'other', HASH);
		expect(pngText(out, CHECKSUM_KEY)).toBeNull();
		expect(pngText(out.subarray(0, 40), 'other')).toBeNull();
	});
});

describe('out= path', () => {
	it('takes a vault path and the format from its extension', () => {
		expect(checkOutPath('Figures/map.png')).toEqual({ path: 'Figures/map.png', format: 'png' });
		expect(checkOutPath(' a//b\\c.SVG ')).toEqual({ path: 'a/b/c.SVG', format: 'svg' });
	});

	it.each([
		['', 'required'],
		['/etc/x.png', 'absolute'],
		['C:/x.png', 'absolute'],
		['../x.png', '".."'],
		['a/./x.png', '".."'],
		['.obsidian/plugins/x/main.png', 'hidden'],
		['a/.trash/x.svg', 'hidden'],
		['notes/x.js', '.png or .svg'],
		['notes/x.png.js', '.png or .svg'],
		['a\u0000b.png', 'control'],
		['Maps/Tea: Shop.png', ': |'],
		['Maps/a|b.svg', ': |'],
		['Maps/what?.png', ': |'],
	])('refuses %j', (out, why) => {
		const r = checkOutPath(out);
		expect(typeof r).toBe('string');
		expect(r as string).toContain(why);
	});
});

describe('scale', () => {
	it('keeps the asked scale while the image fits, else shrinks it to MAX_PIXELS and MAX_SIDE', () => {
		expect(fitScale(800, 600, 2)).toBe(2);
		const s = fitScale(5000, 5000, 2)!;
		expect(s).toBeLessThan(1);
		expect((5000 * s) * (5000 * s)).toBeLessThanOrEqual(MAX_PIXELS);
		const long = fitScale(100000, 50, 2)!;
		expect(100000 * long).toBeLessThanOrEqual(MAX_SIDE);
	});

	it('refuses a drawing that exceeds MAX_PIXELS even at the smallest scale (O79)', () => {
		expect(fitScale(160000, 160000, 2)).toBeNull();
		expect(fitScale(1e9, 1e9, 2)).toBeNull();
		for (const [w, h] of [[40000, 40000], [41000, 41000], [300000, 10]]) {
			const s = fitScale(w, h, 4);
			if (s !== null) expect(Math.round(w * s) * Math.round(h * s)).toBeLessThanOrEqual(MAX_PIXELS);
		}
	});
});

describe('saved name', () => {
	it('is the note name and the block number', () => {
		expect(savedName('Tea Shop', 2)).toBe('Tea Shop 2');
	});
});

describe('portable style values', () => {
	it('keeps references inside the drawing, drops every other url()', () => {
		expect(portableValue('rgb(51, 51, 51)')).toBe(true);
		expect(portableValue('url("#arrowhead")')).toBe(true);
		expect(portableValue('url(#g1)')).toBe(true);
		expect(portableValue('url("https://example.com/x.png")')).toBe(false);
		expect(portableValue('url("app://local/Users/x/theme.png")')).toBe(false);
	});
});

/**
 * Where a browser could find an outside URL in `css`, read roughly and independently of
 * `portableSheet`: comments out, each string replaced by a stand-in that keeps whether it starts with
 * `#`, escapes decoded, CDO and CDC as blanks, and read once more with every `u+…` taken as a unicode
 * range (to engines that still tokenize one, a `url(` may follow it).
 */
function outsideUrls(css: string): string[] {
	const decode = (t: string, name: boolean) => t.replace(name ? /\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([^\n]))/g : /\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([\s\S]))/g, (_, h: string | undefined, c: string | undefined) => {
		const ch = h ? String.fromCodePoint(Math.min(parseInt(h, 16) || 0xfffd, 0x10ffff)) : c ?? '';
		return name && !/^[\w#-]$/.test(ch) ? 'z' : ch;  // outside a string an escape is part of a name or a URL
	});
	// An escape outside a string is a unit of its own (`\"` starts no string), except before a line break.
	// A hex escape takes one blank after it along, a line break too.
	const plain = css.replace(/\/\*[\s\S]*?(?:\*\/|$)|\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[^\n]|"(?:\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[\s\S]|[^"\\\n])*"?|'(?:\\[0-9a-fA-F]{1,6}[ \t\n]?|\\[\s\S]|[^'\\\n])*'?/g,
		m => (m.startsWith('\\') ? m : m.startsWith('/*') ? ' ' : decode(m.slice(1), false).startsWith('#') ? '"#"' : '"x"'));
	const found: string[] = [];
	const named = decode(plain, true);
	// A unicode range starts a token: never inside a name, a hash or an at-keyword.
	for (const text of [named, named.replace(/(^|[^\w\u0080-￿#@-])u\+[0-9a-f?]{1,6}(?:-[0-9a-f]{1,6})?/gi, '$1 ')]) {
		const t = text.replace(/<!--/g, ' ').replace(/(^|[^\w\u0080-￿#@-])-->/g, '$1 ').toLowerCase();  // CDC only starts a token
		found.push(...(t.match(/(?:^|[^\w\u0080-￿#-])(?:url\((?!\s*(?:#|"#"))|(?:-[a-z]+-)?(?:src|image|image-set|cross-fade|element)\()|@(?:import|font-face)(?![\w\u0080-￿-])/g) ?? []));
	}
	return found;
}

describe('portable attributes and elements', () => {
	const OUT = 'https://probe.invalid/x.png';
	const DATA = 'data:image/png;base64,AAAA';
	const keep = (tag: string, name: string, value: string, at: Partial<AttributeContext> = {}) => portableAttribute(tag, name, value, { plain: false, imageShape: false, ...at });

	it('drops every attribute that loads from outside when the file is opened', () => {
		for (const [tag, name] of [['img', 'src'], ['video', 'poster'], ['video', 'src'], ['input', 'src'], ['source', 'src'], ['object', 'data'], ['embed', 'src'],
			['iframe', 'src'], ['body', 'background'], ['link', 'href'], ['use', 'href'], ['feImage', 'href'], ['image', 'href'], ['pattern', 'href'], ['td', 'background']]) {
			expect(keep(tag, name, OUT), `${tag} ${name}`).toBeNull();
			expect(keep(tag, name, `${OUT}#g`), `${tag} ${name} with a fragment`).toBeNull();
			expect(keep(tag, name, ` //probe.invalid/x`), `${tag} ${name} //`).toBeNull();
		}
		for (const name of ['srcset', 'imagesrcset', 'srcdoc', 'onload', 'onerror', 'ONMOUSEOVER']) expect(keep('img', name, '#x'), name).toBeNull();
		expect(keep('a', 'ping', OUT)).toBeNull();
		expect(keep('a', 'PING', '#x')).toBe('#x');
	});

	it('drops plain attributes that become namespaced ones when the file is read as XML', () => {
		for (const name of ['xlink:href', 'XLINK:HREF', 'xmlns', 'xmlns:svg', 'xml:base']) expect(keep('div', name, OUT, { plain: true }), name).toBeNull();
		// Namespaced, as the serializer writes them on SVG elements: kept.
		expect(keep('svg', 'xmlns', 'http://www.w3.org/2000/svg')).toBe('http://www.w3.org/2000/svg');
		expect(keep('svg', 'xlink', 'http://www.w3.org/1999/xlink')).toBe('http://www.w3.org/1999/xlink');
		expect(keep('text', 'space', 'preserve')).toBe('preserve');
		expect(keep('use', 'href', '#marker', { plain: false })).toBe('#marker');
	});

	it('keeps references inside the file, and a data: URL only where it is drawn as a picture', () => {
		expect(keep('use', 'href', '#marker')).toBe('#marker');
		expect(keep('feImage', 'href', ' #g')).toBe(' #g');
		for (const [tag, name] of [['img', 'src'], ['image', 'href'], ['feImage', 'href'], ['input', 'src'], ['video', 'poster']]) expect(keep(tag, name, DATA), `${tag} ${name}`).toBe(DATA);
		for (const [tag, name] of [['iframe', 'src'], ['object', 'data'], ['embed', 'src'], ['use', 'href'], ['link', 'href'], ['video', 'src']]) expect(keep(tag, name, DATA), `${tag} ${name}`).toBeNull();
	});

	it("keeps links, and the address of Mermaid's image shape only (open decision)", () => {
		expect(keep('a', 'href', 'https://example.org/')).toBe('https://example.org/');
		expect(keep('image', 'href', OUT, { imageShape: true })).toBe(OUT);
		// Any other picture: a sequence participant's `icon`, an <image> in a label.
		expect(keep('image', 'href', OUT)).toBeNull();
		expect(keep('feImage', 'href', OUT, { imageShape: true })).toBeNull();
	});

	it('cleans styles and presentation values the way it cleans the sheet', () => {
		expect(keep('div', 'style', `color:red;background:url(${OUT});stroke:blue`)).toBe('color:red;stroke:blue');
		for (const name of ['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-end', 'cursor']) {
			expect(keep('rect', name, `url(${OUT}#g)`), name).toBeNull();
			expect(keep('rect', name, `u\\72 l(${OUT})`), `${name} escaped`).toBeNull();
			expect(keep('rect', name, 'url(#g) red'), `${name} inside`).toBe('url(#g) red');
		}
		for (const [name, value] of [['class', 'node default'], ['d', 'M0,0L10,10'], ['transform', 'translate(1,2)'], ['fill', '#333']]) expect(keep('path', name, value)).toBe(value);
	});

	it('drops elements that run code or load a document, and animations that set what loads', () => {
		for (const tag of ['script', 'iframe', 'frame', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'portal', 'template', 'TEMPLATE', 'svg:image', 'svg:svg']) expect(portableElement(tag, null), tag).toBe(false);
		for (const attr of ['href', 'xlink:href', 'src', 'fill', 'mask', 'style']) expect(portableElement('set', attr), attr).toBe(false);
		expect(portableElement('animate', 'opacity')).toBe(true);
		expect(portableElement('animateMotion', null)).toBe(true);
		for (const tag of ['g', 'rect', 'foreignObject', 'div', 'span', 'img', 'a']) expect(portableElement(tag, null), tag).toBe(true);
	});
});

describe('export config applied', () => {
	const APPLIED = { htmlLabels: false, flowchart: { htmlLabels: false, curve: 'basis' }, fontFamily: EXPORT_FONT, theme: 'forest' };
	it("holds only when every value of the export's directive arrived", () => {
		expect(exportConfigApplied(APPLIED)).toBe(true);
		for (const config of [{}, null, undefined, false, 'x',
			{ ...APPLIED, htmlLabels: undefined }, { ...APPLIED, htmlLabels: true },
			{ ...APPLIED, flowchart: undefined }, { ...APPLIED, flowchart: { htmlLabels: true } },  // frontmatter alone: flowchart labels as HTML
			{ ...APPLIED, fontFamily: undefined }, { ...APPLIED, fontFamily: 'Comic Sans MS' }]) {
			expect(exportConfigApplied(config), JSON.stringify(config)).toBe(false);
		}
	});

	it("asks of Mermaid's parse what the appended directive says", async () => {
		const parsed = await mermaid.parse(withExportConfig('flowchart LR\nA --> B'));
		expect(parsed && exportConfigApplied(parsed.config)).toBe(true);
		for (const src of ['%%{init: {x}}%%\nflowchart LR\nA --> B', 'flowchart LR\nA --> B\n%%{init: ',
			'%%{init: {"themeCSS": ".a { font-family: \'Comic Sans MS\'; }"}}%%\nflowchart LR\nA --> B']) {
			const p = await mermaid.parse(withExportConfig(src), { suppressErrors: true });
			expect(p && exportConfigApplied(p.config), src).toBe(false);
		}
		const escaped = await mermaid.parse(withExportConfig('%%{init: {"themeCSS": ".a { font-family: \\"Comic Sans MS\\"; }"}}%%\nflowchart LR\nA --> B'));
		expect(escaped && exportConfigApplied(escaped.config)).toBe(true);
	});
});

describe('portable style sheets', () => {
	// What Mermaid writes (captured from an export), with the references inside the drawing it uses.
	const MERMAID = '#mde-export-1{font-family:Helvetica, Arial, sans-serif;font-size:16px;fill:#333;}'
		+ '@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}'
		+ '#mde-export-1 .edge-animation-slow{stroke-dasharray:9,5!important;animation:dash 50s linear infinite;}'
		+ '#mde-export-1 .marker{fill:#333333;stroke:#333333;}#mde-export-1 .flowchart-link{stroke:#333333;fill:none;marker-end:url(#arrowhead);}'
		+ '#mde-export-1 .cluster rect{fill:url("#gradient");}#mde-export-1 .label text,#mde-export-1 span{fill:#333;color:#333;}'
		+ '#mde-export-1 .node .label{text-align:center;}#mde-export-1 :root{--mermaid-font-family:"trebuchet ms",verdana,arial,sans-serif;}'
		+ '#mde-export-1 .labelBkg{background-color:rgba(232, 232, 232, 0.5);}@media (prefers-reduced-motion: reduce){#mde-export-1 .x{animation:none;}}';
	const OUT = 'probe.invalid';

	it("keeps Mermaid's own sheet as it is", () => {
		expect(portableSheet(MERMAID)).toBe(MERMAID);
		expect(portableSheet('')).toBe('');
	});

	it('drops each rule that names a URL outside the drawing, keeps the others', () => {
		expect(portableSheet(`a{fill:red}b{mask:url("https://${OUT}/m.svg#m");}c{fill:blue}`)).toBe('a{fill:red}c{fill:blue}');
		for (const url of [`url(https://${OUT}/x)`, `url( https://${OUT}/x )`, `url('https://${OUT}/x')`, `URL("https://${OUT}/x")`,
			`u\\72 l(https://${OUT}/x)`, `\\75\\52L(https://${OUT}/x)`, `u\\72\r\nl(https://${OUT}/x)`, `url(data:image/png;base64,AAAA)`,
			`image-set("https://${OUT}/x" 1x)`, `-webkit-image-set(url(https://${OUT}/x) 1x)`, `cross-fade(url(a), url(b))`, `src("https://${OUT}/x")`,
			`image("https://${OUT}/x")`, `element(#x)`, `-webkit-image-set("https://${OUT}/x" 1x)`]) {
			expect(portableSheet(`a{fill:red}b{mask:${url}}c{fill:blue}`), url).toBe('a{fill:red}c{fill:blue}');
		}
		expect(portableSheet('a{marker-end:url(#arrow)}b{fill:url( "#g" )}')).toBe('a{marker-end:url(#arrow)}b{fill:url( "#g" )}');
	});

	it('drops @import and @font-face, however they are written', () => {
		for (const rule of [`@import url(https://${OUT}/i.css);`, `@import "https://${OUT}/i.css";`, `@IMPORT 'x.css';`, `@\\69mport "x.css";`,
			`@font-face{font-family:t;src:url(https://${OUT}/f.woff)}`, '@font-face{font-family:t;src:local(Arial)}']) {
			expect(portableSheet(`${rule}a{fill:red}`), rule).toBe('a{fill:red}');
		}
	});

	it('keeps rules whose names hold letters every engine reads as part of a name', () => {
		// What Mermaid 12.3 writes for `classDef grün fill:#9f9,rx:12,ry:12` and `class A grün`.
		const sheet = '#mde-export-1 .grün>*{fill:#9f9!important;rx:12!important;ry:12!important;}#mde-export-1 .grün span{fill:#9f9!important;}'
			+ '#mde-export-1 .größe rect{stroke:#333;}#mde-export-1 .日本 rect{fill:red;}#mde-export-1 .x·y rect{fill:red;}#mde-export-1 .ok🙂 rect{fill:red;}';
		expect(portableSheet(sheet)).toBe(sheet);
		for (const c of ['\u00a0', '\u2013', '\u201c', '\u00d7', '\ud800']) expect(portableSheet(`.a${c}b{fill:red}c{fill:blue}`), c).toBe('c{fill:blue}');
	});

	it('drops single declarations of a style attribute', () => {
		expect(portableSheet(`color:red;background:url(https://${OUT}/x);stroke:blue`)).toBe('color:red;stroke:blue');
	});

	it('reads strings, comments and URLs the way CSS does, so none hides a rule', () => {
		const cases: [string, string][] = [
			['a{content:"}"}b{fill:red}', 'a{content:"}"}b{fill:red}'],
			[`a{content:"\\"}b{mask:url(https://${OUT})}"}`, `a{content:"\\"}b{mask:url(https://${OUT})}"}`],  // all one string
			[`a{fill:red/*}b{mask:url(https://${OUT})}*/}`, `a{fill:red/*}b{mask:url(https://${OUT})}*/}`],  // all one comment
			['a{mask:url(x"y)}b{fill:red}', 'b{fill:red}'],  // a bad URL ends at its `)`
			[`a{mask:url(https://${OUT}/}{)}b{fill:red}`, 'b{fill:red}'],  // braces belong to an unquoted URL
			// `1url(` is a number with a unit to CSS, not a URL: dropped anyway, on purpose (URL_TAKING).
			[`a{x:1url(#a/*);}b{mask:url(https://${OUT})}*/}c{fill:red}`, 'c{fill:red}'],
			[`a{x:u+1url(x"y);}b{mask:url(https://${OUT})}`, ''],
			// To an engine that reads `u+a-b` as a unicode range, `url(x"y)` follows it: a bad URL up to `)`.
			[`a{x:u+a-burl(x"y)}b{mask:url(https://${OUT})}"}c{fill:red}`, 'c{fill:red}'],
			[`a{content:"x\nb{mask:url(https://${OUT})}`, ''],  // a string ends at a line break
			[`<!--url(a"b) b{mask:url(https://${OUT})}"}`, '"}'],  // what is left is a string
			// U+00A0 is a name character to some engines and its own token to others; inside a string it is text.
			['.x\u00a0y{fill:red}a{content:"\u00a0"}', 'a{content:"\u00a0"}'],
			// A stray `}` belongs to the rule being read, and goes with it.
			[`a{fill:red}}b{mask:url(https://${OUT})}c{fill:blue}`, 'a{fill:red}c{fill:blue}'],
			[`a{fill:red}x}b{mask:url(https://${OUT})}c{fill:blue}`, 'a{fill:red}c{fill:blue}'],
			// Nothing kept runs into what follows a dropped rule: `@impor` and `t` would read as `@import`.
			[`a{}@impor}b{mask:url(https://${OUT})}t "https://${OUT}/x.css";`, `a{}t "https://${OUT}/x.css";`],
		];
		for (const [sheet, want] of cases) expect(portableSheet(sheet), sheet).toBe(want);
	});

	it('leaves no URL outside the drawing, whatever is cut', () => {
		const parts = ['a{fill:red}', `b{mask:url(https://${OUT})}`, '"', "'", '/*', '*/', '\\', '(', ')', '{', '}', ';', 'url(', 'u+1', '\n', '@import ', '#', '1', 'é',
			'u\\72 l(', '\\75 rl(', 'image-set("', '-webkit-image-set(', 'src(', '-->', '<!--', 'u+a-b', 'https://x', ' ', ' ', '@impor', 't', 'u', 'rl(', '"https://x"'];
		let seed = 7;
		const pick = () => parts[(seed = (seed * 1103515245 + 12345) % 2147483648) % parts.length];
		for (let n = 0; n < 5000; n++) {
			const sheet = Array.from({ length: 12 }, pick).join('');
			const out = portableSheet(sheet);
			// What is kept reads the same again: nothing more to drop.
			expect(portableSheet(out), sheet).toBe(out);
			// And a rougher, independent reading finds no outside URL in it.
			expect(outsideUrls(out), sheet).toEqual([]);
		}
	});

	it('stays linear on crafted text', () => {
		const sheets = ['a{b:url('.repeat(20000), '/*'.repeat(50000), '"'.repeat(50000) + '\\'.repeat(50000), '{'.repeat(100000) + '}'.repeat(100000),
			'\\75'.repeat(40000) + '(', 'a{b:1url(' + 'x'.repeat(100000), `b{mask:url(https://${OUT})}`.repeat(10000)];
		const t = performance.now();
		for (const sheet of sheets) portableSheet(sheet);
		expect(performance.now() - t).toBeLessThan(timeLimit(300));
	});
});

describe('resolveVars', () => {
	const vars: Record<string, string> = { '--a': 'red', '--font': '"Inter", sans-serif' };
	const v = (n: string) => vars[n] ?? '';
	it('replaces variables, takes the fallback when one is unset', () => {
		expect(resolveVars('fill:var(--a);font-family:var(--font)', v)).toBe('fill:red;font-family:"Inter", sans-serif');
		expect(resolveVars('stroke:var(--none, #333)', v)).toBe('stroke:#333');
		expect(resolveVars('stroke:var(--none)', v)).toBe('stroke:');
		expect(resolveVars('x:calc(1px + var(--a))', v)).toBe('x:calc(1px + red)');
		expect(resolveVars('broken:var(--a', v)).toBe('broken:var(--a');
	});

	it('stays linear on crafted nesting', () => {
		const deep = 'fill:' + 'var(--none, '.repeat(20000) + 'x' + ')'.repeat(20000) + ';';
		const t = performance.now();
		resolveVars(deep.repeat(3), v);
		expect(performance.now() - t).toBeLessThan(timeLimit(150));
	});
});

describe('export config', () => {
	it('is appended as a directive that every diagram type still parses with', async () => {
		for (const src of ['flowchart LR\nA[Start] --> B{Ok?}', 'wardley-beta\ntitle Tea\ncomponent Cup [0.70, 0.40]', 'sequenceDiagram\nA->>B: hi', '---\ntitle: x\n---\nflowchart TD\nA-->B']) {
			const text = withExportConfig(src);
			expect(text.startsWith(src)).toBe(true);
			await expect(mermaid.parse(text)).resolves.toBeTruthy();
		}
	});
});
