// @vitest-environment happy-dom
/**
 * The drawing of classes (`applyClasses`) on an SVG exactly as Mermaid 12.1 returned it in Obsidian
 * (captured from a live render): which tags get the classes and the `classDef` styles, and that
 * nothing else in the string changes.
 */
import { describe, expect, it } from 'vitest';
import { timeLimit } from './test-timing';
import { applyClasses, wardleyRender } from './wardley-render';
import { SOURCE, SVG } from './wardley.fixtures';



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
		expect(performance.now() - t).toBeLessThan(timeLimit(400));
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
			expect(performance.now() - t).toBeLessThan(timeLimit(ms));
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
