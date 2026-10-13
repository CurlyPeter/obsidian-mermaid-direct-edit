/**
 * Pure geometry shared by every diagram editor: drag and tap thresholds, the double-tap rule,
 * segment distances and the zoom's fit. No DOM, so everything here is unit-tested.
 */

export interface Pt { x: number; y: number }

/** Below this many screen pixels a pointer gesture is a tap, not a drag. */
export const DRAG_THRESHOLD = 4;
/** Two taps on the same thing within this time are a double tap. */
export const DOUBLE_TAP_MS = 400;
/** The system double click counts if it follows a tap within this time. */
export const DBLCLICK_MS = 600;
/** A touch press on a deletable line this long deletes it (a mouse click deletes at once). */
export const LONG_PRESS_MS = 550;
/** Screen px around a stub's free end that grab it. */
export const STUB_GRAB = 12;
/** After the pointer leaves the menu button and its legend, the legend stays this long (the way between them crosses a gap). */
export const MENU_GRACE_MS = 300;

/** Where `p` lies relative to the segment a→b: distance along it from a, distance off it. */
export function segmentHit(a: Pt, b: Pt, p: Pt): { along: number; perp: number; len: number } | null {
	const len = Math.hypot(b.x - a.x, b.y - a.y);
	if (len < 1) return null;
	const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
	const px = p.x - a.x, py = p.y - a.y;
	return { along: px * ux + py * uy, perp: Math.abs(px * uy - py * ux), len };
}

/**
 * The largest size with the aspect `w` : `h` inside `availW` × `availH`, in whole pixels so it
 * never runs over (the zoomed diagram: scaled up or down to fill the window, aspect kept).
 */
export function fitInside(availW: number, availH: number, w: number, h: number): { width: number; height: number } {
	const aw = Math.max(0, availW), ah = Math.max(0, availH);
	if (!(w > 0 && h > 0) || !Number.isFinite(w / h)) return { width: Math.floor(aw), height: Math.floor(ah) };
	const scale = Math.min(aw / w, ah / h);
	return { width: Math.floor(w * scale), height: Math.floor(h * scale) };
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
