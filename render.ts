import type { Mermaid, RenderResult } from 'mermaid';
import { MAX_SOURCE } from './blocks';

/** Attribute on a rendered, editable SVG that points to its source in the registry. */
export const KEY_ATTR = 'data-mp-src';
/** Attribute naming the editor that owns an editable SVG (`wardley`, `flowchart`). */
export const KIND_ATTR = 'data-mp-kind';
/**
 * Attribute on every rendered SVG, editable or not, that points to its source in the registry:
 * the zoom draws the diagram again from it. Separate from KEY_ATTR, which marks what an editor owns.
 */
export const ZOOM_ATTR = 'data-mde-zoom';

/** One least-recently-used map of source texts by key, at most `cap` entries. */
class Sources {
	readonly byKey = new Map<string, string>();
	private keys = new Map<string, string>();

	constructor(private cap: number) {}

	/** The key of `text`, or a new one from `fresh`. */
	register(text: string, fresh: () => string): string {
		const known = this.keys.get(text);
		if (known) {
			// most recently used last, so eviction takes the oldest
			this.byKey.delete(known);
			this.byKey.set(known, text);
			return known;
		}
		const key = fresh();
		this.byKey.set(key, text);
		this.keys.set(text, key);
		if (this.byKey.size > this.cap) {
			const [oldKey, oldText] = this.byKey.entries().next().value as [string, string];
			this.byKey.delete(oldKey);
			this.keys.delete(oldText);
		}
		return key;
	}
}

/**
 * The exact source text of every SVG this plugin instance rendered, by key. Keys carry a
 * per-instance prefix: a diagram drawn before a plugin reload keeps its old key, and a plain
 * counter restarting at 1 would hand it another diagram's source (review finding #2). Identical
 * text shares one key, and each source is at most MAX_SOURCE long (the editors' blockers, and
 * `wrapRender` for the rest), so redraws do not pile up copies (security review F6). Diagrams
 * only the zoom needs (no editor owns them) have a cap of their own: many of them on screen must
 * not evict an editable map's key, which would cost a redraw on its next edit (review 0.24.0, I-4).
 */
export class SourceRegistry {
	private editable = new Sources(400);
	private zoomOnly = new Sources(200);
	private next = 0;
	private readonly prefix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-`;

	/** The key of an editable diagram's source (`zoomOnly`: one only the zoom draws again). */
	register(text: string, zoomOnly = false): string {
		const fresh = () => this.prefix + String(++this.next);
		return (zoomOnly ? this.zoomOnly : this.editable).register(text, fresh);
	}

	sourceOf(svg: Element): string | undefined {
		return this.editable.byKey.get(svg.getAttribute(KEY_ATTR) ?? '');
	}

	/** The source of any rendered diagram (ZOOM_ATTR), for the zoom. */
	zoomSourceOf(svg: Element): string | undefined {
		const key = svg.getAttribute(ZOOM_ATTR) ?? '';
		return this.editable.byKey.get(key) ?? this.zoomOnly.byKey.get(key);
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
 * Every diagram up to MAX_SOURCE also carries ZOOM_ATTR (the zoom draws it again from its source),
 * and `rendered` hears the render's id once Obsidian has had the chance to insert the drawing.
 */
export function wrapRender(m: Mermaid, registry: SourceRegistry, hooks: RenderHook[], rendered?: (id: string) => void) {
	const render = m.render.bind(m);
	m.render = async (id: string, text: string, container?: Element): Promise<RenderResult> => {
		const r = await render(id, text, container);
		rendered?.(id);
		const zoom = () => (text.length <= MAX_SOURCE ? `${ZOOM_ATTR}="${registry.register(text, true)}"` : '');
		// The root tag only: diagram text further down must not decide which editor owns it.
		const root = r.svg.slice(0, r.svg.indexOf('>') + 1);
		const hook = hooks.find(h => h.roles.some(role => root.includes(`aria-roledescription="${role}"`)));
		if (!hook) return text.length <= MAX_SOURCE ? { ...r, svg: tag(r.svg, zoom()) } : r;
		const svg = hook.transform?.(r.svg, text) ?? r.svg;
		if (hook.blocker(text)) return { ...r, svg: tag(svg, zoom()) };
		const key = registry.register(text);
		return { ...r, svg: tag(svg, `${KEY_ATTR}="${key}" ${KIND_ATTR}="${hook.kind}" ${ZOOM_ATTR}="${key}"`) };
	};
}

/** `svg` with `attrs` added to its root tag (keys and kinds only, never note text). */
const tag = (svg: string, attrs: string) => (attrs.trim() ? svg.replace('<svg ', `<svg ${attrs.trim()} `) : svg);

/**
 * Whether `t` is an element. Not `instanceof Element`: a node in a pop-out window belongs to
 * that window's `Element`, so the check is false there and every diagram in it looked uneditable.
 */
export const isElement = (t: EventTarget | null | undefined): t is Element => !!t && (t as Node).nodeType === 1;

/**
 * The editable SVG of `kind` an event target belongs to, if any. A diagram embedded from another
 * note is left alone: its edit would be written into the host note (security review F3); so is a
 * zoomed diagram whose block the zoom could not find in a note (`mde-static`).
 */
export function diagramOf(target: EventTarget | null, kind: string): SVGSVGElement | null {
	if (!isElement(target)) return null;
	const svg = target.closest<SVGSVGElement>(`svg[${KEY_ATTR}]`);
	// A map drawn before 0.18.0 carries no kind: it is a Wardley map, and the editor asks for a redraw.
	return svg && (svg.getAttribute(KIND_ATTR) ?? 'wardley') === kind && svg.closest('.mermaid') && !svg.closest('.markdown-embed, .mde-static') ? svg : null;
}

/** The editable diagram of `kind` in the `.mermaid` container around `target` (the menu and its legend sit beside the SVG). */
export function diagramIn(target: EventTarget | null, kind: string): SVGSVGElement | null {
	if (!isElement(target)) return null;
	return diagramOf(target.closest('.mermaid')?.querySelector(`:scope > svg[${KEY_ATTR}]`) ?? null, kind);
}
