import { describe, expect, it } from 'vitest';
import type { Mermaid } from 'mermaid';
import { MAX_SOURCE } from './blocks';
import { KEY_ATTR, KIND_ATTR, RenderHook, SourceRegistry, ZOOM_ATTR, wrapRender } from './render';

/** A stand-in for Mermaid: `render` answers an SVG whose root says which diagram type it is. */
const fake = (role: string) => ({
	render: async (id: string) => ({ svg: `<svg id="${id}" width="100%" aria-roledescription="${role}"><g/></svg>`, diagramType: role }),
}) as unknown as Mermaid;

const hook: RenderHook = { kind: 'wardley', roles: ['wardley'], blocker: text => (text.includes('blocked') ? 'no' : null) };

const rootOf = (svg: string) => svg.slice(0, svg.indexOf('>') + 1);
const attr = (svg: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(rootOf(svg))?.[1] ?? null;

describe('wrapRender (zoom key for every diagram, 0.24.0)', () => {
	it('gives a diagram without an editor the zoom key only', async () => {
		const reg = new SourceRegistry(), m = fake('sequence');
		wrapRender(m, reg, [hook]);
		const { svg } = await m.render('m1', 'sequenceDiagram\nA->>B: hi');
		expect(attr(svg, ZOOM_ATTR)).not.toBeNull();
		expect(attr(svg, KEY_ATTR)).toBeNull();
		expect(attr(svg, KIND_ATTR)).toBeNull();
		expect(reg.zoomSourceOf({ getAttribute: (n: string) => attr(svg, n) } as unknown as Element)).toBe('sequenceDiagram\nA->>B: hi');
	});
	it('gives an editable diagram its editor key, kind and the same key for the zoom', async () => {
		const reg = new SourceRegistry(), m = fake('wardley');
		wrapRender(m, reg, [hook]);
		const { svg } = await m.render('m2', 'wardley-beta\ncomponent A [0.5, 0.5]');
		expect(attr(svg, KIND_ATTR)).toBe('wardley');
		expect(attr(svg, KEY_ATTR)).toBe(attr(svg, ZOOM_ATTR));
		expect(attr(svg, 'id')).toBe('m2');
	});
	it('leaves a blocked diagram to the zoom alone', async () => {
		const reg = new SourceRegistry(), m = fake('wardley');
		wrapRender(m, reg, [hook]);
		const { svg } = await m.render('m3', 'wardley-beta\n%% blocked');
		expect(attr(svg, KEY_ATTR)).toBeNull();
		expect(attr(svg, ZOOM_ATTR)).not.toBeNull();
	});
	it('registers no source over MAX_SOURCE', async () => {
		const reg = new SourceRegistry(), m = fake('sequence');
		wrapRender(m, reg, [hook]);
		const { svg } = await m.render('m4', 'sequenceDiagram\n' + 'x'.repeat(MAX_SOURCE));
		expect(attr(svg, ZOOM_ATTR)).toBeNull();
		expect(svg).toBe('<svg id="m4" width="100%" aria-roledescription="sequence"><g/></svg>');
	});
	it('reports each render id', async () => {
		const ids: string[] = [], m = fake('sequence');
		wrapRender(m, new SourceRegistry(), [hook], id => ids.push(id));
		await m.render('a1', 'x');
		await m.render('a2', 'y');
		expect(ids).toEqual(['a1', 'a2']);
	});
	it('puts no note text into the root tag', async () => {
		const reg = new SourceRegistry(), m = fake('wardley');
		wrapRender(m, reg, [hook]);
		const { svg } = await m.render('m5', 'wardley-beta\ncomponent "><script> [0.5, 0.5]');
		expect(rootOf(svg)).not.toContain('<script');
		expect(rootOf(svg)).toMatch(/^<svg data-mp-src="[a-z0-9]+-\d+" data-mp-kind="wardley" data-mde-zoom="[a-z0-9]+-\d+" id="m5"/);
	});
	it('keeps the key of an editable diagram while many diagrams only the zoom needs come and go (review 0.24.0, I-4)', async () => {
		const reg = new SourceRegistry(), map = fake('wardley'), seq = fake('sequence');
		wrapRender(map, reg, [hook]);
		wrapRender(seq, reg, [hook]);
		const { svg } = await map.render('k1', 'wardley-beta\ncomponent Kept [0.5, 0.5]');
		const el = { getAttribute: (n: string) => attr(svg, n) } as unknown as Element;
		for (let i = 0; i < 1000; i++) await seq.render(`s${i}`, `sequenceDiagram\nA->>B: ${i}`);
		expect(reg.sourceOf(el)).toBe('wardley-beta\ncomponent Kept [0.5, 0.5]');
		expect(reg.zoomSourceOf(el)).toBe('wardley-beta\ncomponent Kept [0.5, 0.5]');
	});
});
