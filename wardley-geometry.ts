/**
 * Pure geometry of the Wardley editor: its gesture zones (in screen pixels) and the map
 * projection. No DOM, so everything here is unit-tested. Shared rules: `geometry.ts`.
 */
import type { Pt } from './geometry';

export type { Pt };

/** The plot area of a map in SVG units: evolution runs left→right, visibility bottom→top. */
export interface Box { left: number; right: number; top: number; bottom: number }

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
/** Mermaid draws an accelerator's name this many map px right of and below its anchor point. */
export const FORCE_NAME_OFFSET = 30;

export const evolutionAt = (box: Box, x: number) => (x - box.left) / (box.right - box.left);
export const visibilityAt = (box: Box, y: number) => (box.bottom - y) / (box.bottom - box.top);
export const xOf = (box: Box, evolution: number) => box.left + evolution * (box.right - box.left);
export const yOf = (box: Box, visibility: number) => box.bottom - visibility * (box.bottom - box.top);

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
