import type { Mermaid, RenderResult } from 'mermaid';

/** Attribute on a rendered, editable SVG that points to its source in the registry. */
export const KEY_ATTR = 'data-mp-src';
/** Attribute naming the editor that owns an editable SVG (`wardley`, `flowchart`). */
export const KIND_ATTR = 'data-mp-kind';

/**
 * The exact source text of every editable SVG this plugin instance rendered, by key. Keys carry
 * a per-instance prefix: a diagram drawn before a plugin reload keeps its old key, and a plain
 * counter restarting at 1 would hand it another diagram's source (review finding #2). Identical
 * text shares one key, and each source is at most MAX_SOURCE long (the editors' blockers), so
 * redraws do not pile up copies (security review F6).
 */
export class SourceRegistry {
	private sources = new Map<string, string>();
	private keys = new Map<string, string>();
	private next = 0;
	private readonly prefix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-`;

	register(text: string): string {
		const known = this.keys.get(text);
		if (known) {
			// most recently used last, so eviction takes the oldest
			this.sources.delete(known);
			this.sources.set(known, text);
			return known;
		}
		const key = this.prefix + String(++this.next);
		this.sources.set(key, text);
		this.keys.set(text, key);
		if (this.sources.size > 400) {
			const [oldKey, oldText] = this.sources.entries().next().value as [string, string];
			this.sources.delete(oldKey);
			this.keys.delete(oldText);
		}
		return key;
	}

	sourceOf(svg: Element): string | undefined {
		return this.sources.get(svg.getAttribute(KEY_ATTR) ?? '');
	}
}

/** What one editor contributes to rendering: which SVGs are its own and when they stay untagged. */
export interface RenderHook {
	/** Value of KIND_ATTR. */
	kind: string;
	/** Mermaid's `aria-roledescription` values of this diagram type. */
	roles: string[];
	/** Why a diagram is not editable (it renders, but stays untagged), or null. */
	blocker(text: string): string | null;
	/** Changes to the SVG string before it is tagged (plugin extensions), or null for none. */
	transform?(svg: string, text: string): string | null;
}

/**
 * Wraps `render` so each editable SVG carries its source key and its editor's kind. A diagram
 * its editor's blocker refuses renders as usual and is left untagged, so no editor touches it.
 */
export function wrapRender(m: Mermaid, registry: SourceRegistry, hooks: RenderHook[]) {
	const render = m.render.bind(m);
	m.render = async (id: string, text: string, container?: Element): Promise<RenderResult> => {
		const r = await render(id, text, container);
		// The root tag only: diagram text further down must not decide which editor owns it.
		const root = r.svg.slice(0, r.svg.indexOf('>') + 1);
		const hook = hooks.find(h => h.roles.some(role => root.includes(`aria-roledescription="${role}"`)));
		if (!hook) return r;
		const svg = hook.transform?.(r.svg, text) ?? r.svg;
		if (hook.blocker(text)) return { ...r, svg };
		return { ...r, svg: svg.replace('<svg ', `<svg ${KEY_ATTR}="${registry.register(text)}" ${KIND_ATTR}="${hook.kind}" `) };
	};
}

/**
 * Whether `t` is an element. Not `instanceof Element`: a node in a pop-out window belongs to
 * that window's `Element`, so the check is false there and every diagram in it looked uneditable.
 */
export const isElement = (t: EventTarget | null | undefined): t is Element => !!t && (t as Node).nodeType === 1;

/**
 * The editable SVG of `kind` an event target belongs to, if any. A diagram embedded from another
 * note is left alone: its edit would be written into the host note (security review F3).
 */
export function diagramOf(target: EventTarget | null, kind: string): SVGSVGElement | null {
	if (!isElement(target)) return null;
	const svg = target.closest<SVGSVGElement>(`svg[${KEY_ATTR}]`);
	// A map drawn before 0.18.0 carries no kind: it is a Wardley map, and the editor asks for a redraw.
	return svg && (svg.getAttribute(KIND_ATTR) ?? 'wardley') === kind && svg.closest('.mermaid') && !svg.closest('.markdown-embed') ? svg : null;
}

/** The editable diagram of `kind` in the `.mermaid` container around `target` (the legend sits beside the SVG). */
export function diagramIn(target: EventTarget | null, kind: string): SVGSVGElement | null {
	if (!isElement(target)) return null;
	return diagramOf(target.closest('.mermaid')?.querySelector(`:scope > svg[${KEY_ATTR}]`) ?? null, kind);
}
