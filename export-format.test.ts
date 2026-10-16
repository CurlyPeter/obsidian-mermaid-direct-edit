// @vitest-environment happy-dom
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import mermaid from 'mermaid';
import { describe, expect, it } from 'vitest';
import { CHECKSUM_ATTR, CHECKSUM_KEY, MAX_PIXELS, MAX_SIDE, checkOutPath, fileChecksum, fitScale, pngSize, pngText, pngWithText, portableValue, resolveVars, savedName, sha256Hex, svgChecksum, withExportConfig } from './export-format';
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
