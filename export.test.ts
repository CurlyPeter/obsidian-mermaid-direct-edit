// @vitest-environment happy-dom
/**
 * The export as a whole (`exportSvg`) with a stand-in for Mermaid that hands back a crafted drawing:
 * what the last pass and the directive check leave in the file. The drawing can hold what Mermaid's
 * sanitizer stops on its real label path, so the pass is tested on its own. Real Mermaid output is
 * checked by the E2E suites (`export_no_fetch`, `export_mermaid_sheets`).
 */
import type { Mermaid } from 'mermaid';
import { describe, expect, it } from 'vitest';
import { DirectiveError, exportSvg } from './export';
import { EXPORT_FONT } from './export-format';

// The two DOM helpers of Obsidian's the export uses.
(HTMLElement.prototype as any).createDiv = function (o?: { cls?: string }) {
	const d = this.ownerDocument.createElement('div');
	if (o?.cls) d.className = o.cls;
	this.appendChild(d);
	return d;
};
(HTMLElement.prototype as any).setCssStyles = function (s: Record<string, string>) { Object.assign(this.style, s); };

const APPLIED = { htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: EXPORT_FONT };
const OUT = 'https://probe.invalid';
const OPTS = { width: 800, white: false };

/** Mermaid as far as the export uses it: `parse` answers `parsed`, `render` draws `inner`. */
const mermaidStub = (inner: string, parsed: unknown = { diagramType: 'flowchart', config: APPLIED }) => ({
	parse: async () => parsed,
	render: async (id: string) => ({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">${inner}</svg>` }),
}) as unknown as Mermaid;

const exported = async (inner: string) => String((await exportSvg(mermaidStub(inner), 'flowchart LR\nA --> B', document, OPTS)).data);

describe('exportSvg: the last pass', () => {
	it("keeps the picture of Mermaid's image shape, and no other picture from outside", async () => {
		const svg = await exported(`<g class="image-shape default"><image href="${OUT}/shape.png"/></g>`
			+ `<g><image x="1" xlink:href="${OUT}/icon.png"/></g>`  // a sequence participant's `icon`
			+ `<g class="other"><image href="${OUT}/other.png"/></g><rect class="image-shape"/><image href="${OUT}/loose.png"/>`
			+ `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><svg><g class="image-shape"><image href="${OUT}/fo.png"/></g></svg></div></foreignObject>`);
		expect(svg).toContain(`${OUT}/shape.png`);
		for (const f of ['icon.png', 'other.png', 'loose.png', 'fo.png']) expect(svg, f).not.toContain(f);
	});

	it('keeps references inside the file and links, drops outside references', async () => {
		const svg = await exported(`<use href="#m"/><use xlink:href="${OUT}/u.svg#x"/><use href="${OUT}/v.svg#m"/><a href="https://example.org/"><text>x</text></a>`);
		expect(svg).toContain('href="#m"');
		expect(svg).toContain('https://example.org/');
		expect(svg).not.toContain(OUT);
	});

	it('drops scripts, handlers and animations that set what loads', async () => {
		const svg = await exported(`<rect><animate attributeName="opacity" values="0;1" dur="1s"></animate></rect>`
			+ `<script>fetch("${OUT}/s")</script><rect onload="fetch('${OUT}/h')" width="1" height="1"></rect>`
			+ `<image width="1" height="1"><set attributeName="href" to="${OUT}/set.png"></set></image>`);
		expect(svg).not.toContain(OUT);
		expect(svg).not.toMatch(/<script|onload|<set/);
		expect(svg).toContain('attributeName="opacity"');
	});

	it('drops what a label could smuggle in through namespaces, and templates', async () => {
		const svg = await exported(`<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" xmlns:svg="http://www.w3.org/2000/svg"><svg:image xlink:href="${OUT}/nsp.png" width="9" height="9"></svg:image></div></foreignObject>`
			+ `<foreignObject><p xmlns="http://www.w3.org/1999/xhtml"><svg2 xmlns="http://www.w3.org/2000/svg"><use xlink:href="${OUT}/dn.svg#x"/></svg2></p></foreignObject>`
			+ `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><template><img src="${OUT}/tpl.png"/></template></div></foreignObject>`);
		expect(svg).not.toContain(OUT);
		expect(svg).not.toMatch(/<svg:image|<template/);
	});
});

describe('exportSvg: the directive check', () => {
	it("refuses when Mermaid will not draw with the export's whole config", async () => {
		for (const config of [{}, { htmlLabels: false }, { ...APPLIED, flowchart: { htmlLabels: true } }, { ...APPLIED, fontFamily: 'serif' }]) {
			await expect(exportSvg(mermaidStub('', { config }), 'x', document, OPTS), JSON.stringify(config)).rejects.toBeInstanceOf(DirectiveError);
		}
		await expect(exportSvg(mermaidStub('<rect/>'), 'x', document, OPTS)).resolves.toBeTruthy();
	});

	it("leaves a text that does not parse to render, and its own error", async () => {
		const m = { parse: async () => false, render: async () => { throw new Error('Parse error on line 2'); } } as unknown as Mermaid;
		await expect(exportSvg(m, 'x', document, OPTS)).rejects.toThrow('Parse error on line 2');
	});
});
