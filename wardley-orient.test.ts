/**
 * Links without a direction of their own are written from the upper element to the lower one
 * (0.26.0): `orientLinksOf`, `orientLink`, and the link dialog's `upperEnd` / `linkDirection` /
 * `setLinkDirection`. Every result is read back by the real Mermaid parser through `readModel`,
 * so the check is what Mermaid (and `wardley-read`) see, not only the expected string.
 */
import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import { readModel } from './wardley-model';
import { addLink, getLink, linkDirection, orientLink, orientLinksOf, relink, setClass, setLinkDirection, upperEnd } from './wardley-text';

const MAP = [
	'wardley-beta',
	'anchor Business [0.95, 0.63]',
	'component Cup of Tea [0.79, 0.61]',
	'component "Käse" [0.20, 0.20]',
	'component Hot Water [0.52, 0.80]',
	'component Kettle [0.43, 0.35]',
	'pipeline Kettle {',
	'  component Electric [0.60]',
	'}',
	'component Power [0.10, 0.70]',
	'component Level [0.52, 0.30]',
	'',
	'  Hot Water -> Cup of Tea; needs',
	'"Käse" -.-> Kettle',
	'Power +> Kettle',
	'Power +< Hot Water',
	'Power +<> Cup of Tea',
	'Level -> Hot Water',
	'Electric -> Kettle',
	"Power +'heat'> Business",
	'%% class Cup of Tea -> Hot Water highlight',
].join('\n');

/** The links as Mermaid reads them, `from>to` per link. */
const links = async (src: string) => (await readModel(src, parse)).links.map(l => `${l.from}>${l.to}`);

describe('orientLinksOf', () => {
	it('turns the links of the named element that run upwards, nothing else', async () => {
		const out = orientLinksOf(MAP, ['Hot Water']);
		expect(out).toContain('  Cup of Tea -> Hot Water; needs');
		expect(out).toContain('"Käse" -.-> Kettle');  // not Hot Water's
		expect(out).toContain('Level -> Hot Water');  // level: as written
		expect(out).toContain('Power +< Hot Water');  // a flow keeps its direction
		expect(await links(out)).toContain('Cup of Tea>Hot Water');
	});

	it('turns dashed and two-headed links, keeps one-headed flows and the inline-label flow', async () => {
		const out = orientLinksOf(MAP, ['Käse', 'Power']);
		expect(out).toContain('Kettle -.-> "Käse"');
		expect(out).toContain('Cup of Tea +<> Power');
		expect(out).toContain('Power +> Kettle');
		expect(out).toContain('Power +< Hot Water');
		expect(out).toContain("Power +'heat'> Business");
		const model = await readModel(out, parse);
		expect(model.errors).toEqual([]);
		const vis = new Map(model.elements.map(e => [e.name, e.visibility]));
		for (const l of model.links.filter(x => (!x.flow || x.kind === '+<>') && [x.from, x.to].some(n => n === 'Käse' || n === 'Power'))) expect(vis.get(l.from)!).toBeGreaterThanOrEqual(vis.get(l.to)!);
	});

	it('leaves a pipeline parent and its own component as written: level (Mermaid hides `Child -> Parent`)', () => {
		const src = MAP.replace('component Kettle [0.43, 0.35]', 'component Kettle [0.30, 0.35]');
		expect(orientLinksOf(src, ['Kettle', 'Electric'])).toContain('Electric -> Kettle');
	});

	it('gives a pipeline component its parent\'s visibility', () => {
		const src = 'wardley-beta\ncomponent P [0.40, 0.30]\npipeline P {\n  component C [0.50]\n}\ncomponent Top [0.90, 0.50]\nC -> Top';
		expect(orientLinksOf(src, ['C'])).toContain('Top -> C');
	});

	it('keeps a class on the turned link, which names it by its unordered pair', async () => {
		const out = orientLinksOf(MAP, ['Cup of Tea']);
		expect(out).toContain('%% class Cup of Tea -> Hot Water highlight');
		expect((await readModel(out, parse)).links.find(l => l.from === 'Cup of Tea' && l.to === 'Hot Water')?.classes).toEqual(['highlight']);
	});

	it('leaves a pair linked twice, an undeclared end and a name declared twice as written', () => {
		expect(orientLinksOf('wardley-beta\ncomponent A [0.2, 0.5]\ncomponent B [0.8, 0.5]\nA -> B\nA -.-> B', ['A'])).toContain('A -> B\nA -.-> B');
		expect(orientLinksOf('wardley-beta\ncomponent A [0.2, 0.5]\nA -> Ghost', ['A'])).toContain('A -> Ghost');
		expect(orientLinksOf('wardley-beta\ncomponent A [0.9, 0.5]\ncomponent A [0.2, 0.5]\ncomponent B [0.8, 0.5]\nA -> B', ['A'])).toContain('A -> B');
	});

	it('changes nothing when every link already runs downwards', () => {
		const done = orientLinksOf(MAP, ['Hot Water', 'Käse', 'Power']);
		expect(orientLinksOf(done, ['Hot Water', 'Käse', 'Power', 'Kettle', 'Cup of Tea'])).toBe(done);
	});
});

describe('orientLink', () => {
	it('turns only the link between the two names', () => {
		const out = orientLink(MAP, 'Käse', 'Kettle');
		expect(out).toContain('Kettle -.-> "Käse"');
		expect(out).toContain('  Hot Water -> Cup of Tea; needs');
	});

	it('writes a link drawn upwards top to bottom (the "+" gesture)', async () => {
		const src = addLink(MAP, 'Power', 'Level');
		expect(src).toContain('Power -> Level');
		expect(await links(orientLink(src, 'Power', 'Level'))).toContain('Level>Power');
	});

	it('turns a re-linked link whose new end lies above', () => {
		const out = orientLink(relink(MAP, 'Level', 'Hot Water', 'Hot Water', 'Business'), 'Level', 'Business');
		expect(out).toContain('Business -> Level');
	});
});

describe('the link dialog: upper end, direction, written direction', () => {
	it('names the upper end, the first written when level', () => {
		expect(upperEnd(MAP, 'Hot Water', 'Cup of Tea')).toBe('Cup of Tea');
		expect(upperEnd(MAP, 'Level', 'Hot Water')).toBe('Level');
	});

	it('reads a flow as down or up from the upper end', () => {
		expect(linkDirection(getLink(MAP, 'Power', 'Kettle'), 'Kettle')).toBe('up');
		expect(linkDirection(getLink(MAP, 'Power', 'Hot Water'), 'Hot Water')).toBe('down');  // `Power +< Hot Water` points at Power, below
		expect(linkDirection(getLink(MAP, 'Hot Water', 'Cup of Tea'), 'Cup of Tea')).toBe('line');
		expect(linkDirection(getLink(MAP, 'Power', 'Cup of Tea'), 'Cup of Tea')).toBe('both');
	});

	it('writes a reversed arrow as names swapped, never as `+<`', async () => {
		const up = setLinkDirection(MAP, 'Hot Water', 'Cup of Tea', 'up', 'needs', 'Cup of Tea');
		expect(up).toContain('  Hot Water +> Cup of Tea; needs');
		const down = setLinkDirection(MAP, 'Hot Water', 'Cup of Tea', 'down', 'needs', 'Cup of Tea');
		expect(down).toContain('  Cup of Tea +> Hot Water; needs');
		expect(await links(down)).toContain('Cup of Tea>Hot Water');
		const legacy = setLinkDirection(MAP, 'Power', 'Hot Water', 'down', 'x', 'Hot Water');
		expect(legacy).toContain('Hot Water +> Power; x');
		expect(legacy).not.toMatch(/\+<(?!>)/);
	});

	it('writes a link without an arrow top to bottom, also when its arrow is switched off', () => {
		expect(setLinkDirection(MAP, 'Power', 'Kettle', 'line', '', 'Kettle')).toContain('Kettle -> Power');
		expect(setLinkDirection(MAP, 'Käse', 'Kettle', 'dashed', 'maybe', 'Kettle')).toContain('Kettle -.-> "Käse"; maybe');
	});

	it('keeps the highlight of a link whose ends swapped', () => {
		const out = setClass(setLinkDirection(MAP, 'Hot Water', 'Cup of Tea', 'down', '', 'Cup of Tea'), ['Hot Water', 'Cup of Tea'], 'highlight', true);
		expect(out.match(/%% class/g)).toHaveLength(1);
	});
});
