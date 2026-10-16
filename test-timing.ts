/**
 * Test helper: the time limits of the timing cases (a crafted note must never freeze Obsidian).
 * They are tuned on a fast laptop; a slower machine (a small VM, a busy CI runner) sets
 * `MDE_TIME_SCALE` (e.g. 3) to stretch every limit alike. A super-linear parser misses its limit
 * by orders of magnitude, so a constant factor keeps what these cases are for. Not bundled.
 */
const scale = Number(process.env.MDE_TIME_SCALE ?? '1');

/** `ms` stretched by `MDE_TIME_SCALE` (default 1). */
export const timeLimit = (ms: number) => ms * (Number.isFinite(scale) && scale > 0 ? scale : 1);
