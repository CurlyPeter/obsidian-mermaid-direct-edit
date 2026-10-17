/**
 * The shadow behind what a press would take (hover) and behind what is taken (pressed, its
 * dialog open, a waiting link starting from it). Only in the drawing, never in the text, and
 * never hit by the pointer. A node gets the class `mde-glow` (its pipeline box too) and its links
 * glow with it; a link gets a group of two lines under it, a soft base and a dash pattern that
 * runs the way `run` says (styles.css). See CLAUDE.md → "Editing Wardley maps".
 */

/** A node's group (with the pipeline box standing for a pipeline parent, and its link lines), or a link's line. */
export type GlowTarget = { node: SVGGElement; box?: Element | null; links?: SVGLineElement[] } | { line: SVGLineElement };

/** Where a link's dashes run: to the line's second end (`x2`, the text's `to`), to its first, or not at all. */
export type GlowRun = 'forward' | 'backward' | 'none';

const NS = 'http://www.w3.org/2000/svg';
const GLOW_CLASS = 'mde-glow';
const LINK_GLOW_CLASS = 'mde-link-glow';

export class Glow {
	/** Glowing elements; for a link line, its overlay. */
	private readonly shown = new Map<Element, Element | null>();

	/** `run` is asked once per link that starts glowing. */
	constructor(private readonly run: (line: SVGLineElement) => GlowRun) {}

	/** Shows the shadow on exactly `targets` (nulls skipped), takes it from everything else. */
	show(targets: (GlowTarget | null)[]) {
		const want = new Set<Element>();
		for (const t of targets) {
			if (!t) continue;
			if ('line' in t) want.add(t.line);
			else {
				want.add(t.node);
				if (t.box) want.add(t.box);
				for (const l of t.links ?? []) want.add(l);
			}
		}
		for (const [el, overlay] of Array.from(this.shown)) {
			if (want.has(el) && el.isConnected) continue;
			if (overlay) overlay.remove();
			else el.classList.remove(GLOW_CLASS);
			this.shown.delete(el);
		}
		for (const el of want) {
			if (this.shown.has(el) || !el.isConnected) continue;
			this.shown.set(el, el.matches('line.wardley-link') ? this.overlay(el as SVGLineElement) : (el.classList.add(GLOW_CLASS), null));
		}
	}

	clear() {
		this.show([]);
	}

	/** Two lines on the link's own coordinates, inserted right before it (so drawn under it). */
	private overlay(line: SVGLineElement): Element {
		const doc = line.ownerDocument;
		const g = doc.createElementNS(NS, 'g');
		g.setAttribute('class', `${LINK_GLOW_CLASS} mde-run-${this.run(line)}`);
		g.setAttribute('pointer-events', 'none');
		for (const cls of ['mde-glow-base', 'mde-glow-run']) {
			const l = doc.createElementNS(NS, 'line');
			l.setAttribute('class', cls);
			for (const a of ['x1', 'y1', 'x2', 'y2']) l.setAttribute(a, line.getAttribute(a) ?? '0');
			g.appendChild(l);
		}
		line.parentNode?.insertBefore(g, line);
		return g;
	}
}
