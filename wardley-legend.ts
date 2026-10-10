import { legendSide } from './wardley-geometry';
import { isElement } from './wardley-map';

export type LegendKind = 'component' | 'anchor' | 'evolve' | 'inertia' | 'note' | 'annotation' | 'accelerator' | 'deaccelerator' | 'pipeline';

/** Icons are fixed markup written here, never built from map text. */
const ITEMS: [LegendKind, string, string][] = [
	['component', 'Component', "<circle cx='12' cy='8' r='5' fill='white' stroke='currentColor' stroke-width='1.5'/>"],
	['anchor', 'Anchor', "<text x='12' y='12' text-anchor='middle' font-size='11' font-weight='bold' fill='currentColor'>A</text>"],
	['evolve', 'Evolve', "<line x1='2' y1='8' x2='19' y2='8' stroke='#e45' stroke-dasharray='3 2'/><path d='M18 5l4 3-4 3z' fill='#e45'/>"],
	['inertia', 'Inertia', "<line x1='12' y1='2' x2='12' y2='14' stroke='currentColor' stroke-width='4'/>"],
	['note', 'Note', "<text x='12' y='12' text-anchor='middle' font-size='10' font-weight='bold' fill='currentColor'>Aa</text>"],
	['annotation', 'Annotation', "<circle cx='12' cy='8' r='6.5' fill='white' stroke='currentColor' stroke-width='1.2'/><text x='12' y='11' text-anchor='middle' font-size='8' font-weight='bold' fill='#222'>1</text>"],
	['accelerator', 'Accelerator', "<path d='M3 5h11V2l7 6-7 6v-3H3z' fill='white' stroke='currentColor'/>"],
	['deaccelerator', 'Deaccelerator', "<path d='M21 5H10V2L3 8l7 6v-3h11z' fill='white' stroke='currentColor'/>"],
	['pipeline', 'Pipeline', "<rect x='2' y='4' width='20' height='8' rx='2' fill='none' stroke='currentColor'/><circle cx='7' cy='8' r='2' fill='white' stroke='currentColor'/><circle cx='17' cy='8' r='2' fill='white' stroke='currentColor'/>"],
];

/**
 * The legend that adds elements to a map. Shown only while the pointer is in the very bottom
 * left or right corner of the map (about the size of Obsidian's edit button, so elements near a
 * corner stay editable), in that corner, and kept open while the pointer is on it.
 */
export class Legend {
	private shown: HTMLElement | null = null;

	/** The legend item under the target, if any. */
	static itemAt(target: EventTarget | null): LegendKind | null {
		if (!isElement(target)) return null;
		return (target.closest('.mp-wardley-legend [data-mp-add]')?.getAttribute('data-mp-add') as LegendKind | null) ?? null;
	}

	static contains(target: EventTarget | null): boolean {
		return isElement(target) && !!target.closest('.mp-wardley-legend');
	}

	/** Shows the legend of `box` (the map's `.mermaid` container) in the corner the pointer is in, hides any other. */
	update(box: HTMLElement | null, target: EventTarget | null, x: number, y: number) {
		const side = box ? legendSide(box.getBoundingClientRect(), x, y) : null;
		if (!side && this.shown && this.shown.contains(target as Node)) return;
		const legend = side && box ? this.ensure(box) : null;
		if (this.shown && this.shown !== legend) this.shown.removeClass('is-visible');
		if (legend && side) {
			// Keep the side while the pointer is on the legend itself, so it does not jump.
			if (!legend.hasClass('is-visible') || !legend.contains(target as Node)) {
				legend.toggleClass('is-left', side === 'left');
				legend.toggleClass('is-right', side === 'right');
			}
			legend.addClass('is-visible');
		}
		this.shown = legend;
	}

	private ensure(box: HTMLElement): HTMLElement {
		const existing = box.querySelector<HTMLElement>(':scope > .mp-wardley-legend');
		if (existing) return existing;
		box.addClass('mp-wardley-host');
		const legend = box.createDiv({ cls: 'mp-wardley-legend' });
		for (const [kind, label, icon] of ITEMS) {
			const item = legend.createDiv({ cls: 'mp-wardley-legend-item', attr: { 'data-mp-add': kind, 'aria-label': `Add ${label.toLowerCase()}` } });
			item.innerHTML = `<svg width='24' height='16' viewBox='0 0 24 16'>${icon}</svg>`;
			item.createSpan({ text: label });
		}
		return legend;
	}

	/** Removes every legend the plugin added (unload), in each of `docs` (the app's windows). */
	destroy(docs: Iterable<Document>) {
		for (const doc of docs) {
			doc.querySelectorAll('.mp-wardley-legend').forEach(el => el.remove());
			doc.querySelectorAll('.mp-wardley-host').forEach(el => el.removeClass('mp-wardley-host'));
		}
		this.shown = null;
	}
}
