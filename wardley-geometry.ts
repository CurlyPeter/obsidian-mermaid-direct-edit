/**
 * Pure geometry of the Wardley editor: the gesture zones (in screen pixels), map projection
 * and the double-tap rule. No DOM, so everything here is unit-tested.
 */

export interface Pt { x: number; y: number }
/** The plot area of a map in SVG units: evolution runs left→right, visibility bottom→top. */
export interface Box { left: number; right: number; top: number; bottom: number }

/** Below this many screen pixels a pointer gesture is a tap, not a drag. */
export const DRAG_THRESHOLD = 4;
/** Two taps on the same thing within this time are a double tap. */
export const DOUBLE_TAP_MS = 400;
/** The system double click counts if it follows a tap within this time. */
export const DBLCLICK_MS = 600;
/** A touch press on a deletable line this long deletes it (a mouse click deletes at once). */
export const LONG_PRESS_MS = 550;
/** Screen pixels around an evolve arrow's tip that grab it (the dashed line is 1 px). */
export const TIP_RADIUS = 10;
/**
 * A link end is grabbed on the line just outside the node, never at the centre, where a press
 * moves the node: `from`..`to` screen pixels along the line, within `width` of it. Inside a
 * pipeline box the box wins and a link needs a precise hit (`precise`).
 */
export const LINK_GRAB = { from: 7, to: 28, width: 6, precise: 3 };
/** Screen pixels around a node centre that accept a dropped link end. */
export const DROP_RADIUS = 16;
/** Mermaid ends link lines at the node's rim (6 map px); an endpoint this close belongs to it. */
export const END_TOLERANCE = 10;
/** Ring around a node centre, in screen px, where a press starts a new link. */
export const PLUS_RING = { from: 9, to: 22 };
/** Length of the provisional stub a click in the ring draws, in map px. */
export const STUB_LENGTH = 45;
/** Screen px around a stub's free end that grab it. */
export const STUB_GRAB = 12;
/** Bottom corner zones (screen px) where the pointer shows the legend: about Obsidian's edit button. */
export const LEGEND_ZONE = { width: 32, height: 32 };
/** Mermaid draws an accelerator's name this many map px right of and below its anchor point. */
export const FORCE_NAME_OFFSET = 30;

export const evolutionAt = (box: Box, x: number) => (x - box.left) / (box.right - box.left);
export const visibilityAt = (box: Box, y: number) => (box.bottom - y) / (box.bottom - box.top);
export const xOf = (box: Box, evolution: number) => box.left + evolution * (box.right - box.left);
export const yOf = (box: Box, visibility: number) => box.bottom - visibility * (box.bottom - box.top);

/** Where `p` lies relative to the segment a→b: distance along it from a, distance off it. */
export function segmentHit(a: Pt, b: Pt, p: Pt): { along: number; perp: number; len: number } | null {
	const len = Math.hypot(b.x - a.x, b.y - a.y);
	if (len < 1) return null;
	const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
	const px = p.x - a.x, py = p.y - a.y;
	return { along: px * ux + py * uy, perp: Math.abs(px * uy - py * ux), len };
}

/**
 * Which part of a link a point `along` it falls in: an end band (re-link) of at most a third of
 * the line, starting LINK_GRAB.from out from either end, or the middle between them (dialog).
 */
export function linkPart(along: number, len: number): 1 | 2 | 'middle' | null {
	const band = Math.min(LINK_GRAB.to, len / 3);
	if (along >= LINK_GRAB.from && along <= band) return 1;
	if (len - along >= LINK_GRAB.from && len - along <= band) return 2;
	if (along > band && along < len - band) return 'middle';
	return null;
}

/** The shaft of an evolve arrow: past the node, short of the tip. */
export const onTrendShaft = (along: number, len: number, perp: number) =>
	along >= 10 && along <= len - TIP_RADIUS - 2 && perp <= LINK_GRAB.width;

/**
 * The evolution an evolve arrow points to when its drawn tip is at `tipX`: Mermaid stops the
 * line `nodeRadius + 2` short of the target, on the side away from the node at `x1`.
 */
export const trendTargetX = (tipX: number, x1: number, nodeRadius: number) =>
	tipX + Math.sign(tipX - x1 || 1) * (nodeRadius + 2);

/** The bottom corner of a map's rectangle the point is in, if any. */
export function legendSide(r: { left: number; right: number; bottom: number; width: number; height: number }, x: number, y: number): 'left' | 'right' | null {
	const zw = Math.min(LEGEND_ZONE.width, r.width / 2), zh = Math.min(LEGEND_ZONE.height, r.height / 2);
	if (y < r.bottom - zh || y > r.bottom) return null;
	if (x >= r.left && x <= r.left + zw) return 'left';
	if (x <= r.right && x >= r.right - zw) return 'right';
	return null;
}

/**
 * Double-tap detection for touch (which has no dblclick): a second tap on the same key within
 * DOUBLE_TAP_MS opens it. `recent()` lets the system's dblclick claim the last tap.
 */
export class TapDetector {
	private last: { key: unknown; at: number; open: () => void } | null = null;

	constructor(private now: () => number = () => Date.now()) {}

	/** Records a tap; returns true (and opens) when it completes a double tap. */
	tap(key: unknown, open: () => void): boolean {
		const at = this.now();
		const prev = this.last;
		this.last = { key, at, open };
		if (prev && prev.key === key && at - prev.at < DOUBLE_TAP_MS) {
			this.last = null;
			open();
			return true;
		}
		return false;
	}

	/** The last tap if it is younger than `ms`, consumed. */
	take(ms: number): { key: unknown; open: () => void } | null {
		const t = this.last;
		if (!t || this.now() - t.at >= ms) return null;
		this.last = null;
		return t;
	}

	clear() {
		this.last = null;
	}
}
