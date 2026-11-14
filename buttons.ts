import type { TFile } from 'obsidian';
import { setIcon, setTooltip } from 'obsidian';

/**
 * Buttons other plugins put beside the menu button of an editable diagram (`api.addDiagramButton`,
 * README → "For plugin developers"). This plugin draws them and tells their owner which note and block
 * a drawing shows; what a button does is entirely its owner's.
 */

/** The block a drawing shows, as a button's owner sees it. */
export interface DiagramTarget {
	/** The note holding the block. */
	file: TFile;
	/** The block is number `index` (from 0) of the note's `count` fenced mermaid blocks of their own. */
	index: number;
	count: number;
	/** The block's opening fence line as the note holds it now, e.g. "```mermaid". */
	fence: string;
	/** The block's text now (between the fences). */
	source: string;
	/** Which editor owns the drawing: `wardley` or `flowchart`. */
	kind: string;
	/** Whether editing this kind of diagram is switched on, on this device. */
	editing: boolean;
	/** The drawing is the zoom's, not the note's. */
	zoomed: boolean;
}

export interface DiagramButtonSpec {
	/** Lower-case letters, digits and `-`: one button of this id per drawing. */
	id: string;
	/** An icon name as `setIcon` takes it, e.g. `lucide-users`. */
	icon: string;
	tooltip: string;
	/**
	 * Called once for each new drawing (each render), and for every drawing on screen when the owner
	 * calls `refreshDiagramButtons`. Set the button's look here (classes, `setIcon`, `setTooltip`;
	 * the class `mde-pinned` keeps it visible without hovering the drawing). Return false to hide the
	 * button on this drawing. `target` is null where the block cannot be found in a note.
	 */
	update(button: HTMLElement, target: DiagramTarget | null): boolean;
	/** A click on the button, with the block as the note holds it at that moment. */
	click(target: DiagramTarget, button: HTMLElement, evt: MouseEvent): void;
}

/** Class of every such button; `main.ts` takes each event of a press on one, as for Zoom in. */
export const EXT_BUTTON = 'mde-ext-button';
const ID = /^[a-z0-9-]{1,40}$/;

/** A container holding a visible pinned button stays visible itself; its other buttons still show on hover only. */
function markPinned(left: HTMLElement | null) {
	left?.toggleClass('mde-has-pinned', !!left.querySelector(`:scope > .${EXT_BUTTON}.mde-pinned:not(.mde-hidden)`));
}

export class DiagramButtons {
	private specs: DiagramButtonSpec[] = [];

	constructor(
		/** The block a drawing's `.mermaid` box shows, or null. */
		private resolve: (box: HTMLElement) => DiagramTarget | null,
		/** The box a button belongs to. */
		private boxOf: (button: Element) => HTMLElement | null,
	) {}

	/**
	 * Adds a button to every editable drawing, those on screen at once and every one drawn later; the
	 * returned function removes it again.
	 */
	add(spec: DiagramButtonSpec, docs: () => Iterable<Document>): () => void {
		if (!ID.test(spec.id)) throw new Error(`A diagram button id must match ${ID}.`);
		if (this.specs.some(s => s.id === spec.id)) throw new Error(`A diagram button "${spec.id}" exists already.`);
		this.specs.push(spec);
		for (const doc of docs()) {
			for (const left of Array.from(doc.querySelectorAll<HTMLElement>('.mermaid > .mde-actions-left'))) this.place(left, left.parentElement!);
		}
		return () => {
			this.specs = this.specs.filter(s => s !== spec);
			for (const button of this.buttons(docs(), spec.id)) {
				const left = button.parentElement;
				button.remove();
				markPinned(left);
			}
		};
	}

	/**
	 * Puts each button into `left` (the menu's container of the drawing in `box`) where it is missing,
	 * and lets its owner set it up once per drawing: the drawing's id is kept on the button, and every
	 * render brings a new one. Hovering, which decorates again, only finds the buttons in place.
	 */
	place(left: HTMLElement, box: HTMLElement) {
		const drawn = box.querySelector(':scope > svg')?.id ?? '';
		let target: DiagramTarget | null | undefined;
		for (const spec of this.specs) {
			let button = left.querySelector<HTMLElement>(`:scope > .${EXT_BUTTON}[data-mde-button="${spec.id}"]`);
			if (button?.getAttribute('data-mde-drawn') === drawn) continue;
			if (!button) {
				button = left.createDiv({ cls: `embed-action ${EXT_BUTTON}`, attr: { 'data-mde-button': spec.id } });
				setIcon(button, spec.icon);
				setTooltip(button, spec.tooltip);
				// Right after the menu button and the buttons before it, ahead of the legend the row may hold.
				const before = left.querySelectorAll(`:scope > .mde-menu-button, :scope > .${EXT_BUTTON}:not([data-mde-button="${spec.id}"])`);
				if (before.length) before[before.length - 1].after(button);
			}
			button.setAttribute('data-mde-drawn', drawn);
			if (target === undefined) target = this.resolve(box);
			this.update(spec, button, target);
		}
		markPinned(left);
	}

	/** Every button of `id` (or of every owner) on every drawing in `docs` is set up again. */
	refresh(docs: Iterable<Document>, id?: string) {
		for (const spec of this.specs) {
			if (id !== undefined && spec.id !== id) continue;
			for (const button of this.buttons(docs, spec.id)) {
				const box = this.boxOf(button);
				this.update(spec, button, box ? this.resolve(box) : null);
				markPinned(button.parentElement);
			}
		}
	}

	/** A click on one of the buttons: its owner learns the block as the note holds it now. */
	click(button: HTMLElement, evt: MouseEvent) {
		const spec = this.specs.find(s => s.id === button.getAttribute('data-mde-button'));
		const box = this.boxOf(button);
		const target = spec && box ? this.resolve(box) : null;
		if (spec && target) spec.click(target, button, evt);
	}

	private update(spec: DiagramButtonSpec, button: HTMLElement, target: DiagramTarget | null) {
		let shown = false;
		try {
			shown = spec.update(button, target) !== false;
		} catch (e) {
			console.error(`[mermaid-direct-edit] the diagram button "${spec.id}" failed to update:`, e);
		}
		button.toggleClass('mde-hidden', !shown);
	}

	private *buttons(docs: Iterable<Document>, id: string) {
		for (const doc of docs) yield* Array.from(doc.querySelectorAll<HTMLElement>(`.${EXT_BUTTON}[data-mde-button="${id}"]`));
	}
}
