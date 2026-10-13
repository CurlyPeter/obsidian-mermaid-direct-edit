import { setIcon, setTooltip } from 'obsidian';
import { KEY_ATTR, KIND_ATTR, ZOOM_ATTR, isElement } from './render';

/** Marks a `.mermaid` box the plugin decorated (positioning for its buttons, removed on unload). */
export const HOST = 'mde-host';
/** A diagram drawn in the zoom whose block was not found in a note: shown, never edited. */
export const STATIC = 'mde-static';

/**
 * One button in the look of Obsidian's own embed actions ("Edit this block"): an icon, a tooltip,
 * `embed-action` so Live Preview's styles apply, `extra` to find it again.
 */
export function actionButton(parent: HTMLElement, icon: string, tooltip: string | null, extra: string): HTMLElement {
	const b = parent.createDiv({ cls: `embed-action ${extra}` });
	setIcon(b, icon);
	if (tooltip) setTooltip(b, tooltip);
	return b;
}

/**
 * The buttons of a rendered diagram (DEV.md → "Zoom and the menu button (0.24.0)"):
 *
 * - **Zoom in**, top right. In Live Preview it goes first into Obsidian's own toolbar of the block,
 *   beside "Edit this block", exactly where an image has it; in reading view (no toolbar there) it
 *   gets a toolbar of its own at the same place. Every diagram the zoom can draw has it.
 * - **The menu**, top left of an editable diagram: its legend opens below it (`legend.ts`).
 *
 * The buttons live inside the `.mermaid` box: reading view moves a drawn box into a new section
 * without rendering it again, and the buttons travel with it. Idempotent, so it runs after every
 * render and again whenever the pointer reaches a diagram. `zoomed`: the box is the zoom's, which
 * keeps its own toolbar at the top right and only needs the menu.
 */
export function decorate(box: HTMLElement, zoomed = false) {
	const svg = box.querySelector<SVGSVGElement>(':scope > svg');
	if (!svg) return;
	box.addClass(HOST);
	const editable = svg.hasAttribute(KEY_ATTR) && !box.closest(`.markdown-embed, .${STATIC}`);
	const kind = svg.getAttribute(KIND_ATTR) ?? 'wardley';  // a map drawn before 0.18.0 has no kind
	let left = box.querySelector<HTMLElement>(':scope > .mde-actions-left');
	if (left && (!editable || left.getAttribute('data-kind') !== kind)) {
		left.remove();
		left = null;
	}
	if (editable && !left) {
		left = box.createDiv({ cls: 'mde-actions mde-actions-left', attr: { 'data-kind': kind } });
		// No tooltip: the legend opens on hover right where it would show.
		actionButton(left, 'lucide-menu', null, 'mde-menu-button').setAttr('aria-label', 'Diagram menu');
	}
	if (zoomed || !svg.hasAttribute(ZOOM_ATTR)) return;
	const toolbar = box.parentElement?.matches('.cm-embed-block') ? box.parentElement.querySelector<HTMLElement>(':scope > .embed-actions') : null;
	if (toolbar) {
		if (!toolbar.querySelector('.mde-zoom-button')) toolbar.prepend(actionButton(createDiv(), 'lucide-zoom-in', 'Zoom in', 'mde-zoom-button'));
		return;
	}
	if (!box.querySelector(':scope > .mde-actions-right')) {
		actionButton(box.createDiv({ cls: 'mde-actions mde-actions-right' }), 'lucide-zoom-in', 'Zoom in', 'mde-zoom-button');
	}
}

/** The `.mermaid` box of the diagram under `target`: inside it, or anywhere in its Live Preview block. */
export function boxAt(target: EventTarget | null): HTMLElement | null {
	if (!isElement(target)) return null;
	const block = target.closest('.cm-embed-block.cm-lang-mermaid');
	return (block?.querySelector<HTMLElement>(':scope > .mermaid') ?? target.closest<HTMLElement>('.mermaid')) || null;
}

/** The box a zoom button belongs to: in its own toolbar, or in Obsidian's toolbar beside the box. */
export function boxOfZoomButton(button: Element): HTMLElement | null {
	return button.closest<HTMLElement>('.mermaid') ?? button.closest('.cm-embed-block')?.querySelector<HTMLElement>(':scope > .mermaid') ?? null;
}

/** Removes every button and mark the plugin added (unload), in each of `docs` (the app's windows). */
export function undecorate(docs: Iterable<Document>) {
	for (const doc of docs) {
		doc.querySelectorAll('.mde-actions, .mde-zoom-button').forEach(el => el.remove());
		doc.querySelectorAll(`.${HOST}`).forEach(el => el.removeClass(HOST));
	}
}
