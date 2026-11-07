// @vitest-environment happy-dom
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./actions', () => ({ decorate: vi.fn() }));

const { PeleHook, namespaceMarkers } = await import('./pele');

/** A stand-in for Pele: `mount` hands back a handle that records what it was given. */
function fakePele() {
	const mounted: string[] = [];
	const pele = {
		mount: (_box: unknown, source: string) => {
			mounted.push(source);
			let src = source;
			return { get source() { return src; }, update: (s: string) => { src = s; mounted.push(s); }, refresh() {}, destroy() {} };
		},
		render: () => 'rendered by pele',
	};
	return { pele, mounted };
}

/** A fresh global object (a vm context's), so Pele's own `var pele = …` can be run against it. */
function freshGlobal() {
	const ctx = vm.createContext({});
	return { ctx, g: vm.runInContext('globalThis', ctx) as Record<string, any> };
}

describe('PeleHook', () => {
	it('catches Pele loaded after the plugin: its `var pele = …` lands in the accessor', () => {
		const { ctx, g } = freshGlobal();
		const hook = new PeleHook(() => undefined, g);
		expect(hook.install()).toBe(true);
		expect(hook.live).toBe(true);
		ctx.mountedByPele = [] as string[];
		vm.runInContext('"use strict"; var pele = { mount(box, s) { mountedByPele.push(s); return { source: s, update() {}, refresh() {}, destroy() {} }; }, render() { return "r"; } };', ctx);
		expect(hook.original).toBeDefined();
		expect(vm.runInContext('pele.render()', ctx)).toBe('r');          // passed through
		expect(vm.runInContext('pele.mount === pele.mount', ctx)).toBe(true);
		expect(g.pele.mount).not.toBe(hook.original!.mount);            // answered by the hook
	});

	it('wraps Pele loaded before the plugin (a non-configurable `var`) and puts it back on unload', () => {
		const { g } = freshGlobal();
		// What a window holds once Pele's script ran (measured in Obsidian 1.15.0): writable, not
		// configurable. A vm context reports its `var` globals as configurable, so it is set by hand.
		const original = { mount() { return null; }, render() { return 'r'; } };
		Object.defineProperty(g, 'pele', { value: original, writable: true, enumerable: true, configurable: false });
		const hook = new PeleHook(() => undefined, g);
		expect(hook.install()).toBe(true);
		expect(g.pele).not.toBe(original);
		expect(g.pele.render()).toBe('r');
		hook.uninstall();
		expect(hook.live).toBe(false);
		expect(g.pele).toBe(original);
		// A second load (plugin reloaded) wraps it again.
		const again = new PeleHook(() => undefined, g);
		expect(again.install()).toBe(true);
		expect(again.original).toBe(original);
		again.uninstall();
		expect(g.pele).toBe(original);
	});

	it('restores Pele after an unload when it was caught by the accessor, and wraps it again', () => {
		const { g } = freshGlobal();
		const { pele } = fakePele();
		const hook = new PeleHook(() => undefined, g);
		hook.install();
		g.pele = pele;
		hook.uninstall();
		expect(g.pele).toBe(pele);
		const again = new PeleHook(() => undefined, g);
		expect(again.install()).toBe(true);
		expect(again.original).toBe(pele);
	});

	it('never takes a proxy of its own for Pele', () => {
		const { g } = freshGlobal();
		const { pele } = fakePele();
		const hook = new PeleHook(() => undefined, g);
		hook.install();
		g.pele = pele;
		g.pele = g.pele;                       // the proxy assigned back
		expect(hook.original).toBe(pele);
		// Handing a block to Pele reaches the real one, not the hook again.
		const handle = g.pele.mount({}, 'flowchart LR\nA-->B', {});
		expect(handle.source).toBe('flowchart LR\nA-->B');
	});

	it('refuses a global it cannot replace', () => {
		const { g } = freshGlobal();
		Object.defineProperty(g, 'pele', { value: fakePele().pele, writable: false, configurable: false });
		const hook = new PeleHook(() => undefined, g);
		expect(hook.install()).toBe(false);
		expect(hook.live).toBe(false);
	});

	it('hands a block to Pele while it has no Mermaid to draw with, updates included', () => {
		const { g } = freshGlobal();
		const { pele, mounted } = fakePele();
		const hook = new PeleHook(() => undefined, g);
		hook.install();
		g.pele = pele;
		const handle = g.pele.mount({}, 'graph TD\nA-->B', {});
		handle.update('graph TD\nA-->C');
		expect(mounted).toEqual(['graph TD\nA-->B', 'graph TD\nA-->C']);
		expect(handle.source).toBe('graph TD\nA-->C');
	});
});

describe('namespaceMarkers', () => {
	const drawing = (style: boolean) => new DOMParser().parseFromString(
		'<svg xmlns="http://www.w3.org/2000/svg" id="m1">' +
		(style ? '<style>#m1 #arrowhead{fill:red} #arrowhead-2{fill:blue} .x{marker-end:url(#arrowhead)}</style>' : '') +
		'<defs><marker id="arrowhead"></marker><marker id="arrowhead-2"></marker><marker id="link-arrow-end-m1"></marker></defs>' +
		'<line marker-end="url(#arrowhead)"></line><line marker-start="url(#link-arrow-end-m1)"></line></svg>',
		'image/svg+xml').documentElement;

	it('prefixes markers Mermaid left without the drawing id, with their references and rules', () => {
		const svg = drawing(true);
		namespaceMarkers(svg, 'm1');
		const ids = Array.from(svg.querySelectorAll('marker')).map(m => m.id);
		expect(ids).toEqual(['m1-arrowhead', 'm1-arrowhead-2', 'link-arrow-end-m1']);
		expect(svg.querySelector('line')!.getAttribute('marker-end')).toBe('url(#m1-arrowhead)');
		expect(svg.querySelectorAll('line')[1].getAttribute('marker-start')).toBe('url(#link-arrow-end-m1)');
		// `#arrowhead` is not taken for the start of `#arrowhead-2`, and each got its own prefix once.
		expect(svg.querySelector('style')!.textContent).toBe('#m1 #m1-arrowhead{fill:red} #m1-arrowhead-2{fill:blue} .x{marker-end:url(#m1-arrowhead)}');
	});

	it('keeps markers Mermaid already namespaced (styles.css finds them by `link-arrow-`)', () => {
		const svg = drawing(true);
		namespaceMarkers(svg, 'm1');
		expect(svg.querySelector('marker[id^="link-arrow-"]')).not.toBeNull();
	});

	it('leaves a drawing without a style sheet alone, as Obsidian 1.14.5 did', () => {
		const svg = drawing(false);
		namespaceMarkers(svg, 'm1');
		expect(Array.from(svg.querySelectorAll('marker')).map(m => m.id)).toEqual(['arrowhead', 'arrowhead-2', 'link-arrow-end-m1']);
	});
});
