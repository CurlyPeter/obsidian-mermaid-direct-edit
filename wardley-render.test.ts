// @vitest-environment happy-dom
/**
 * The drawing of classes (`applyClasses`) on an SVG exactly as Mermaid 12.1 returned it in Obsidian
 * (captured from a live render): which tags get the classes and the `classDef` styles, and that
 * nothing else in the string changes.
 */
import { describe, expect, it } from 'vitest';
import { applyClasses, wardleyRender } from './wardley-render';

const SOURCE = [
	'wardley-beta',
	'anchor Public [0.95, 0.62]',
	'component Kettle [0.30, 0.40] (buy) (inertia)',
	'component Power [0.10, 0.70]',
	'component Market [0.60, 0.20] (market)',
	'pipeline Power {',
	'  component Grid [0.75]',
	'}',
	'Public -> Kettle',
	'Kettle +> Power',
	'Public -.-> Market',
].join('\n');

/** Mermaid 12.1's SVG for SOURCE, as Obsidian rendered it. */
const SVG = `<svg id="fixture" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 900px;" viewBox="0 0 900 600" role="graphics-document document" aria-roledescription="wardley"><g class="wardley-map"><rect class="wardley-background" width="900" height="600" fill="white"></rect><g class="wardley-axes"><line x1="48" x2="852" y1="552" y2="552" stroke="#333333" stroke-width="1"></line><line x1="48" x2="48" y1="48" y2="552" stroke="#333333" stroke-width="1"></line><text class="wardley-axis-label wardley-axis-label-x" x="450" y="588" fill="#131300" font-size="12" font-weight="bold" text-anchor="middle">Evolution</text><text class="wardley-axis-label wardley-axis-label-y" x="16" y="300" fill="#131300" font-size="12" font-weight="bold" text-anchor="middle" transform="rotate(-90 16 300)">Visibility</text></g><g class="wardley-stages"><text class="wardley-stage-label" x="148.5" y="568" fill="#131300" font-size="10" text-anchor="middle">Genesis</text><line x1="249" x2="249" y1="48" y2="552" stroke="#000" stroke-width="1" stroke-dasharray="5 5" opacity="0.8"></line><text class="wardley-stage-label" x="349.5" y="568" fill="#131300" font-size="10" text-anchor="middle">Custom Built</text><line x1="450" x2="450" y1="48" y2="552" stroke="#000" stroke-width="1" stroke-dasharray="5 5" opacity="0.8"></line><text class="wardley-stage-label" x="550.5" y="568" fill="#131300" font-size="10" text-anchor="middle">Product</text><line x1="651" x2="651" y1="48" y2="552" stroke="#000" stroke-width="1" stroke-dasharray="5 5" opacity="0.8"></line><text class="wardley-stage-label" x="751.5" y="568" fill="#131300" font-size="10" text-anchor="middle">Commodity</text></g><g class="wardley-pipelines"><rect class="wardley-pipeline-box" x="636" y="489.6" width="30" height="24" fill="none" stroke="#333333" stroke-width="1.5" rx="4" ry="4"></rect></g><g class="wardley-pipeline-links"></g><g class="wardley-links"><line class="wardley-link" x1="543.6294059768842" y1="78.47959408623211" x2="372.4505940231158" y2="395.52040591376795" stroke="#333333" stroke-width="1"></line><line class="wardley-link" x1="375.3311397649045" y1="402.5759608653151" x2="644.5159555332931" y2="485.99072964642204" stroke="#333333" stroke-width="1" marker-end="url(#link-arrow-end-fixture)"></line><line class="wardley-link wardley-link--dashed" x1="541.161906910771" y1="75.9781083301943" x2="214.118093089229" y2="246.82189166980578" stroke="#333333" stroke-width="1" stroke-dasharray="6 6"></line></g><g class="wardley-trends"></g><g class="wardley-nodes"><g class="wardley-node wardley-node--anchor"><text x="546.48" y="70.20000000000005" class="wardley-node-label" fill="#000" font-size="10" font-weight="bold" text-anchor="middle" dominant-baseline="middle">Public</text></g><g class="wardley-node wardley-node--component"><circle class="wardley-buy-overlay" cx="369.6" cy="400.8" r="12" fill="#ccc" stroke="#333333" stroke-width="1"></circle><circle cx="369.6" cy="400.8" r="6" fill="white" stroke="#333333" stroke-width="1"></circle><line class="wardley-inertia" x1="406.6" y1="394.8" x2="406.6" y2="406.8" stroke="#333333" stroke-width="6"></line><text x="387.6" y="382.8" class="wardley-node-label" fill="#131300" font-size="10" font-weight="normal" text-anchor="start" dominant-baseline="auto">Kettle</text></g><g class="wardley-node wardley-node--component"><rect x="646.2" y="483.2" width="9.600000000000001" height="9.600000000000001" fill="white" stroke="#333333" stroke-width="1"></rect><text x="659" y="480" class="wardley-node-label" fill="#131300" font-size="10" font-weight="normal" text-anchor="start" dominant-baseline="auto">Power</text></g><g class="wardley-node wardley-node--component"><circle class="wardley-market-overlay" cx="208.8" cy="249.60000000000002" r="12" fill="white" stroke="#333333" stroke-width="1"></circle><line class="wardley-market-line" x1="208.8" y1="242.40000000000003" x2="202.56461709275206" y2="253.20000000000002" stroke="#333333" stroke-width="1"></line><line class="wardley-market-line" x1="202.56461709275206" y1="253.20000000000002" x2="215.03538290724796" y2="253.20000000000002" stroke="#333333" stroke-width="1"></line><line class="wardley-market-line" x1="215.03538290724796" y1="253.20000000000002" x2="208.8" y2="242.40000000000003" stroke="#333333" stroke-width="1"></line><circle class="wardley-market-dot" cx="208.8" cy="242.40000000000003" r="4.199999999999999" fill="white" stroke="#333333" stroke-width="2"></circle><circle class="wardley-market-dot" cx="202.56461709275206" cy="253.20000000000002" r="4.199999999999999" fill="white" stroke="#333333" stroke-width="2"></circle><circle class="wardley-market-dot" cx="215.03538290724796" cy="253.20000000000002" r="4.199999999999999" fill="white" stroke="#333333" stroke-width="2"></circle><text x="226.8" y="231.60000000000002" class="wardley-node-label" fill="#131300" font-size="10" font-weight="normal" text-anchor="start" dominant-baseline="auto">Market</text></g><g class="wardley-node wardley-node--pipeline-component"><circle cx="651" cy="501.6" r="6" fill="white" stroke="#333333" stroke-width="1"></circle><text x="659" y="493.6" class="wardley-node-label" fill="#131300" font-size="10" font-weight="normal" text-anchor="start" dominant-baseline="auto">Grid</text></g></g></g><defs><marker id="arrow-fixture" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#dc3545" stroke="none"></path></marker><marker id="link-arrow-end-fixture" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#333333" stroke="none"></path></marker><marker id="link-arrow-start-fixture" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 10 0 L 0 5 L 10 10 z" fill="#333333" stroke="none"></path></marker></defs></svg>`;

const tags = (svg: string, re: RegExp) => svg.match(re) ?? [];
/** The string with the plugin's insertions taken out again: must give back Mermaid's SVG. */
const strip = (svg: string) => svg.replace(/ mde-class(?: mde-class-[\w-]+)+/g, '').replace(/(<(?:circle|rect|text|line)) style="[^"]*"/g, '$1');
const LINKS = /<line[^>]*class="wardley-link[^>]*>/g;

describe('applyClasses', () => {
	it('does nothing without class lines', () => {
		expect(applyClasses(SVG, SOURCE)).toBeNull();
		expect(applyClasses(SVG, `${SOURCE}\n%% class Teapot highlight`)).toBeNull();
	});

	it('classes the node group of every kind of element, never the container', () => {
		const src = `${SOURCE}\n%% class Public, Kettle, Power, Market, Grid highlight`;
		const out = applyClasses(SVG, src)!;
		expect(tags(out, /<g class="[^"]*">/g).filter(t => t.includes('mde-class'))).toEqual([
			'<g class="wardley-node wardley-node--anchor mde-class mde-class-highlight">',
			'<g class="wardley-node wardley-node--component mde-class mde-class-highlight">',
			'<g class="wardley-node wardley-node--component mde-class mde-class-highlight">',
			'<g class="wardley-node wardley-node--component mde-class mde-class-highlight">',
			'<g class="wardley-node wardley-node--pipeline-component mde-class mde-class-highlight">',
		]);
		expect(out).toContain('<g class="wardley-nodes">');
		expect(strip(out)).toBe(SVG);
	});

	it('finds a link by the nodes its ends touch, either written order, dashed and flow links too', () => {
		const out = applyClasses(SVG, `${SOURCE}\n%% class Power -> Kettle highlight\n%% class Public -> Market muted`)!;
		const links = tags(out, LINKS);
		expect(links.map(l => /class="([^"]*)"/.exec(l)![1])).toEqual([
			'wardley-link', 'wardley-link mde-class mde-class-highlight', 'wardley-link wardley-link--dashed mde-class mde-class-muted',
		]);
		expect(strip(out)).toBe(SVG);
	});

	it('writes classDef styles on the shape and the label; the label takes the stroke colour', () => {
		const src = `${SOURCE}\n%% classDef highlight stroke:#8000F0,stroke-width:5px\n%% class Kettle, Power highlight\n%% class Public -> Kettle highlight`;
		const out = applyClasses(SVG, src)!;
		const kettle = /<g class="wardley-node wardley-node--component mde-class[^"]*">[\s\S]*?<\/g>/.exec(out)![0];
		expect(tags(kettle, /<circle[^>]*>/g).map(t => /style="([^"]*)"/.exec(t)?.[1] ?? null)).toEqual([null, 'stroke:#8000F0;stroke-width:5px']);
		expect(/<text[^>]*>/.exec(kettle)![0]).toContain('style="fill:#8000F0"');
		const power = /<g class="wardley-node wardley-node--component mde-class[^"]*">[\s\S]*?<\/g>/g;
		power.exec(out);
		expect(/<rect[^>]*>/.exec(power.exec(out)![0])![0]).toContain('style="stroke:#8000F0;stroke-width:5px"');
		expect(tags(out, LINKS)[0]).toContain('style="stroke:#8000F0;stroke-width:5px"');
		expect(strip(out)).toBe(SVG);
	});

	it('runs after the inertia placement in the render hook', () => {
		const out = wardleyRender.transform!(SVG, `${SOURCE}\n%% mp-inertia Kettle 0.50\n%% class Kettle highlight`)!;
		expect(out).toContain('mde-class-highlight');
		expect(out).toMatch(/<line class="wardley-inertia" x1="450"/);
	});

	it('stays fast with many class lines (comments are outside Mermaid\'s size limit)', () => {
		const src = `${SOURCE}\n${'%% class Kettle, Public -> Kettle, Teapot highlight\n'.repeat(20000)}`;
		const t = performance.now();
		expect(applyClasses(SVG, src)).toContain('mde-class-highlight');
		expect(performance.now() - t).toBeLessThan(400);
	});

	describe('security review 0.19.0 (F-A, F-D): bounded on crafted class lines', () => {
		// One link drawn 3000 times, as Mermaid draws duplicate links.
		const line = '<line class="wardley-link" x1="56" y1="50" x2="194" y2="50" stroke="#333333" stroke-width="1"></line>';
		const nodes = '<g class="wardley-nodes"><g class="wardley-node wardley-node--component"><circle cx="50" cy="50" r="6"></circle><text x="58" y="42" class="wardley-node-label">A</text></g>'
			+ '<g class="wardley-node wardley-node--component"><circle cx="200" cy="50" r="6"></circle><text x="208" y="42" class="wardley-node-label">B</text></g></g>';
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="wardley"><g class="wardley-links">${line.repeat(3000)}</g>${nodes}</svg>`;
		const timed = (f: () => string | null, ms: number) => {
			const t = performance.now();
			const out = f();
			expect(performance.now() - t).toBeLessThan(ms);
			return out;
		};
		it('many classes on a link drawn many times: at most 8 per element, a bounded insertion', () => {
			const src = 'wardley-beta\n' + Array.from({ length: 750 }, (_, i) => `%% class A -> B c${i}`).join('\n');
			const out = timed(() => applyClasses(svg, src), 300);
			expect(out === null || out.length - svg.length <= 256 * 1024).toBe(true);
			const few = applyClasses(svg, 'wardley-beta\n%% class A -> B one\n%% class B -> A two')!;
			expect(tags(few, /mde-class mde-class-one mde-class-two/g).length).toBe(3000);
		});
		it('one node with very many distinct classes', () => {
			const src = 'wardley-beta\n' + Array.from({ length: 80000 }, (_, i) => `%% class A c${i}`).join('\n');
			const out = timed(() => applyClasses(svg, src), 600)!;
			expect(tags(out, /mde-class-c\d+/g).length).toBe(8);
		});
		it('class names longer than 40 characters are not drawn', () => {
			expect(applyClasses(svg, `wardley-beta\n%% class A -> B ${'x'.repeat(41)}`)).toBeNull();
		});
	});

	it('keeps Mermaid\'s drawing when the string does not match its parse', () => {
		const broken = SVG.replace('<g class="wardley-node wardley-node--anchor">', '<g  class="wardley-node wardley-node--anchor">');
		expect(applyClasses(broken, `${SOURCE}\n%% class Public highlight`)).toBeNull();
	});
});
