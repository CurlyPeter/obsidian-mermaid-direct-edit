import { MENU_GRACE_MS } from './geometry';
import { isElement } from './render';

/** Height of one legend row in px (icon 16 + padding), and the fewest rows before columns are added. */
const ITEM_HEIGHT = 22;
const MIN_ROWS = 3;

/** One legend entry: what it adds (`data-mp-add`), its label, and a fixed 24x16 SVG icon body. */
export type LegendItem = readonly [kind: string, label: string, icon: string];

/**
 * The legend that adds elements to a diagram, the menu of its menu button (top left, `actions.ts`).
 * It opens below the button while the mouse is on the button or on the legend, and closes a moment
 * after the mouse left both (MENU_GRACE_MS: the way from the button to the legend crosses a gap);
 * a finger opens and closes it with a tap on the button. Icons are fixed markup from the editor,
 * never built from diagram text.
 */
export class Legend {
	private shown: HTMLElement | null = null;
	private hideTimer = 0;

	constructor(private items: readonly LegendItem[]) {}

	/** The legend item under the target, if any. */
	static itemAt(target: EventTarget | null): string | null {
		if (!isElement(target)) return null;
		return target.closest('.mp-legend [data-mp-add]')?.getAttribute('data-mp-add') ?? null;
	}

	static contains(target: EventTarget | null): boolean {
		return isElement(target) && !!target.closest('.mp-legend');
	}

	/** Whether the target is a menu button. */
	static onButton(target: EventTarget | null): boolean {
		return isElement(target) && !!target.closest('.mde-menu-button');
	}

	/** Whether the target is on a menu: its button or its legend. */
	static onMenu(target: EventTarget | null): boolean {
		return isElement(target) && !!target.closest('.mde-actions-left');
	}

	isShown(): boolean {
		return !!this.shown?.isConnected && this.shown.hasClass('is-visible');
	}

	/** Opens the legend of `box` (the diagram's `.mermaid`) below its menu button, closes any other. */
	show(box: HTMLElement) {
		this.cancelHide();
		const host = box.querySelector<HTMLElement>(':scope > .mde-actions-left');
		if (!host) return;
		const legend = this.ensure(host);
		if (this.shown === legend && this.isShown()) return;
		this.hide();
		// As many rows as fit below the button, then further columns: on a short diagram a single
		// column ran over the text below it, where its lower items could not be clicked.
		const top = host.offsetTop + host.offsetHeight + 4;
		const rows = Math.max(MIN_ROWS, Math.floor((box.clientHeight - top - 8) / ITEM_HEIGHT));
		legend.style.gridTemplateRows = `repeat(${Math.min(rows, this.items.length)}, auto)`;
		legend.addClass('is-visible');
		host.addClass('is-open');
		this.shown = legend;
	}

	/** A tap on the button: open, or close when it is open. */
	toggle(box: HTMLElement) {
		const open = this.isShown() && this.shown!.parentElement === box.querySelector(':scope > .mde-actions-left');
		if (open) this.hide();
		else this.show(box);
	}

	/** The mouse left the menu: close after a short grace, unless it comes back. */
	leave() {
		if (!this.shown || this.hideTimer) return;
		const win = this.shown.ownerDocument.defaultView ?? window;
		this.hideTimer = win.setTimeout(() => {
			this.hideTimer = 0;
			this.hide();
		}, MENU_GRACE_MS);
	}

	/** Closes the shown legend: once an entry is chosen it must not cover what is clicked next. */
	hide() {
		this.cancelHide();
		this.shown?.removeClass('is-visible');
		this.shown?.parentElement?.removeClass('is-open');
		this.shown = null;
	}

	private cancelHide() {
		if (!this.hideTimer) return;
		(this.shown?.ownerDocument.defaultView ?? window).clearTimeout(this.hideTimer);
		this.hideTimer = 0;
	}

	private ensure(host: HTMLElement): HTMLElement {
		const existing = host.querySelector<HTMLElement>(':scope > .mp-legend');
		if (existing) return existing;
		const legend = host.createDiv({ cls: 'mp-legend' });
		for (const [kind, label, icon] of this.items) {
			const item = legend.createDiv({ cls: 'mp-legend-item', attr: { 'data-mp-add': kind, 'aria-label': `Add ${label.toLowerCase()}` } });
			item.innerHTML = `<svg width='24' height='16' viewBox='0 0 24 16'>${icon}</svg>`;
			item.createSpan({ text: label });
		}
		return legend;
	}

	/** Removes every legend the plugin added (unload), in each of `docs` (the app's windows). */
	destroy(docs: Iterable<Document>) {
		this.hide();
		for (const doc of docs) doc.querySelectorAll('.mp-legend').forEach(el => el.remove());
	}
}
