import { LEGEND_ZONE_TOUCH, legendSide } from './geometry';
import { isElement } from './render';

/** Height of one legend row in px (icon 16 + padding), and the fewest rows before columns are added. */
const ITEM_HEIGHT = 22;
const MIN_ROWS = 3;

/** One legend entry: what it adds (`data-mp-add`), its label, and a fixed 24x16 SVG icon body. */
export type LegendItem = readonly [kind: string, label: string, icon: string];

/**
 * The legend that adds elements to a diagram. Shown only while the pointer is in the very bottom
 * left or right corner of the diagram (about the size of Obsidian's edit button, so elements near
 * a corner stay editable), in that corner, and kept open while the pointer is on it. Icons are
 * fixed markup from the editor, never built from diagram text.
 */
export class Legend {
	private shown: HTMLElement | null = null;

	constructor(private items: readonly LegendItem[]) {}

	/** The legend item under the target, if any. */
	static itemAt(target: EventTarget | null): string | null {
		if (!isElement(target)) return null;
		return target.closest('.mp-legend [data-mp-add]')?.getAttribute('data-mp-add') ?? null;
	}

	static contains(target: EventTarget | null): boolean {
		return isElement(target) && !!target.closest('.mp-legend');
	}

	/**
	 * Shows the legend of `box` (the diagram's `.mermaid` container) in the corner the pointer is in,
	 * hides any other. True while a legend is shown.
	 */
	update(box: HTMLElement | null, target: EventTarget | null, x: number, y: number, touch = false): boolean {
		const side = box ? legendSide(box.getBoundingClientRect(), x, y, touch ? LEGEND_ZONE_TOUCH : undefined) : null;
		if (!side && this.shown && this.shown.contains(target as Node)) return true;
		const legend = side && box ? this.ensure(box) : null;
		if (this.shown && this.shown !== legend) this.shown.removeClass('is-visible');
		if (legend && side) {
			// Keep the side while the pointer is on the legend itself, so it does not jump.
			if (!legend.hasClass('is-visible') || !legend.contains(target as Node)) {
				legend.toggleClass('is-left', side === 'left');
				legend.toggleClass('is-right', side === 'right');
				// As many rows as fit the diagram's height, then further columns: on a short diagram a
				// single column ran over the text above it, where its upper items could not be clicked.
				const rows = Math.max(MIN_ROWS, Math.floor((box!.clientHeight - 16) / ITEM_HEIGHT));
				legend.style.gridTemplateRows = `repeat(${Math.min(rows, this.items.length)}, auto)`;
			}
			legend.addClass('is-visible');
		}
		this.shown = legend;
		return !!legend;
	}

	/** Closes the shown legend: once an entry is chosen it must not cover what is clicked next. */
	hide() {
		this.shown?.removeClass('is-visible');
		this.shown = null;
	}

	private ensure(box: HTMLElement): HTMLElement {
		const existing = box.querySelector<HTMLElement>(':scope > .mp-legend');
		if (existing) return existing;
		box.addClass('mp-legend-host');
		const legend = box.createDiv({ cls: 'mp-legend' });
		for (const [kind, label, icon] of this.items) {
			const item = legend.createDiv({ cls: 'mp-legend-item', attr: { 'data-mp-add': kind, 'aria-label': `Add ${label.toLowerCase()}` } });
			item.innerHTML = `<svg width='24' height='16' viewBox='0 0 24 16'>${icon}</svg>`;
			item.createSpan({ text: label });
		}
		return legend;
	}

	/** Removes every legend the plugin added (unload), in each of `docs` (the app's windows). */
	destroy(docs: Iterable<Document>) {
		for (const doc of docs) {
			doc.querySelectorAll('.mp-legend').forEach(el => el.remove());
			doc.querySelectorAll('.mp-legend-host').forEach(el => el.removeClass('mp-legend-host'));
		}
		this.shown = null;
	}
}
