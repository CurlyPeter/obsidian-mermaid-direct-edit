/**
 * The boundary of a group of components (DEV.md → "Groups for wardley-beta"), pure geometry in
 * SVG units, no DOM.
 *
 * The area is what a disc of radius `r` covers when it travels along the group's skeleton: the
 * members' centres, the links between two members, and, where the members are not connected by
 * such links, the shortest connections that join them (a spanning tree, as Kelp diagrams do), so
 * a group is one area. Its inner corners are rounded by a closing (grow by CLOSE, shrink back by
 * CLOSE: convex parts stay where they are, a notch where two arms meet fills in). The boundary is
 * that area's outline (a contour found with marching squares), holes filled, smoothed into a
 * closed path.
 */
import type { Pt } from './wardley-geometry';

/** Radius of the disc in map units: Mermaid draws a component with radius 6. */
export const GROUP_RADIUS = 16;
/** Grid spacing of the distance field in map units; coarser for a group over a large area. */
const STEP = 4;
/** Grid cells one group may use: a larger area gets a coarser grid instead of no boundary. */
const MAX_CELLS = 120_000;
/** Radius of the closing that rounds inner corners, in map units. */
const CLOSE = 8;
/** Distance evaluations one render may spend on all its groups together (crafted maps). */
export const GROUP_BUDGET = 1_000_000;

export type Segment = [Pt, Pt];

/**
 * The skeleton of a group: the given links (pairs of indices into `points`), plus the shortest
 * connections between parts the links leave apart. A single point is a segment of length 0.
 */
export function skeleton(points: Pt[], links: [number, number][]): Segment[] {
	const n = points.length;
	if (n === 0) return [];
	const parent = points.map((_, i) => i);
	const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
	const segments: Segment[] = [];
	for (const [a, b] of links) {
		if (a === b || a < 0 || b < 0 || a >= n || b >= n) continue;
		segments.push([points[a], points[b]]);
		parent[find(a)] = find(b);
	}
	const pairs: { a: number; b: number; d: number }[] = [];
	for (let a = 0; a < n; a++) {
		for (let b = a + 1; b < n; b++) pairs.push({ a, b, d: Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y) });
	}
	pairs.sort((p, q) => p.d - q.d);
	for (const { a, b } of pairs) {
		if (find(a) === find(b)) continue;
		segments.push([points[a], points[b]]);
		parent[find(a)] = find(b);
	}
	if (segments.length === 0) segments.push([points[0], points[0]]);
	// A point no segment touches (a link to itself only) still gets its disc.
	points.forEach(p => { if (!segments.some(([s, t]) => s === p || t === p)) segments.push([p, p]); });
	return segments;
}

/** Distance from `p` to the segment `s`–`t`. */
function distance(px: number, py: number, s: Pt, t: Pt): number {
	const dx = t.x - s.x, dy = t.y - s.y;
	const len2 = dx * dx + dy * dy;
	const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x) * dx + (py - s.y) * dy) / len2));
	return Math.hypot(px - (s.x + u * dx), py - (s.y + u * dy));
}

/**
 * The outer outlines of the area within `r` of the segments, each a closed polygon. `budget`
 * counts distance evaluations; null when the area would cost more than it holds.
 */
export function outline(segments: Segment[], r: number, budget: { left: number }): Pt[][] | null {
	if (segments.length === 0) return [];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [s, t] of segments) {
		minX = Math.min(minX, s.x, t.x); maxX = Math.max(maxX, s.x, t.x);
		minY = Math.min(minY, s.y, t.y); maxY = Math.max(maxY, s.y, t.y);
	}
	if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
	const span = (maxX - minX + 2 * (r + CLOSE)) * (maxY - minY + 2 * (r + CLOSE));
	const STEP = Math.max(4, Math.sqrt(span / MAX_CELLS));
	const pad = r + CLOSE + 2 * STEP;
	const x0 = minX - pad, y0 = minY - pad;
	const nx = Math.ceil((maxX - minX + 2 * pad) / STEP) + 1, ny = Math.ceil((maxY - minY + 2 * pad) / STEP) + 1;
	if (!Number.isFinite(nx * ny) || 4 * nx * ny > budget.left) return null;
	budget.left -= 3 * nx * ny;
	const far = r + CLOSE + 2 * STEP;
	const field = new Float64Array(nx * ny).fill(far);
	// Each segment updates only the rows and columns within reach of it (its band), so the cost
	// follows the area of the band, not of the bounding box.
	const reach = r + CLOSE + STEP;
	for (const [s, t] of segments) {
		const j0 = Math.max(0, Math.floor((Math.min(s.y, t.y) - reach - y0) / STEP));
		const j1 = Math.min(ny - 1, Math.ceil((Math.max(s.y, t.y) + reach - y0) / STEP));
		for (let j = j0; j <= j1; j++) {
			const y = y0 + j * STEP;
			let lo: number, hi: number;
			if (Math.abs(t.y - s.y) < 1e-9) {
				lo = Math.min(s.x, t.x); hi = Math.max(s.x, t.x);
			} else {
				const u1 = Math.max(0, Math.min(1, (y - reach - s.y) / (t.y - s.y)));
				const u2 = Math.max(0, Math.min(1, (y + reach - s.y) / (t.y - s.y)));
				const xa = s.x + u1 * (t.x - s.x), xb = s.x + u2 * (t.x - s.x);
				lo = Math.min(xa, xb); hi = Math.max(xa, xb);
			}
			const i0 = Math.max(0, Math.floor((lo - reach - x0) / STEP));
			const i1 = Math.min(nx - 1, Math.ceil((hi + reach - x0) / STEP));
			budget.left -= i1 - i0 + 1;
			if (budget.left < 0) return null;
			for (let i = i0; i <= i1; i++) {
				const d = distance(x0 + i * STEP, y, s, t);
				const k = j * nx + i;
				if (d < field[k]) field[k] = d;
			}
		}
	}
	// Closing: the area within r + CLOSE of the skeleton, shrunk by CLOSE, measured as each cell's
	// distance to the nearest cell outside the grown area (exact Euclidean distance transform; that
	// cell lies beyond the true edge by half a step on average). A closing only adds area, so the
	// result is the swept area itself united with the closed one: the outline follows the exact
	// field wherever nothing is filled, and the grid's coarser distances only where a notch is.
	const grown = r + CLOSE;
	const sq = new Float64Array(nx * ny);
	for (let k = 0; k < sq.length; k++) sq[k] = field[k] < grown ? INF : 0;
	edt(sq, nx, ny);
	const area = new Float64Array(nx * ny);
	for (let k = 0; k < sq.length; k++) area[k] = Math.min(field[k] - r, CLOSE + STEP / 2 - Math.sqrt(sq[k]) * STEP);
	return outerLoops(contours(area, nx, ny, x0, y0, 0, STEP));
}

const INF = 1e20;

/**
 * Squared Euclidean distance transform on the grid, in place: each cell's squared distance (in
 * cells) to the nearest cell holding 0. Columns, then rows, each in linear time (Felzenszwalb and
 * Huttenlocher's lower envelope of parabolas).
 */
function edt(grid: Float64Array, nx: number, ny: number): void {
	const n = Math.max(nx, ny);
	const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
	const pass = (len: number, get: (q: number) => number, set: (q: number, val: number) => void) => {
		for (let q = 0; q < len; q++) f[q] = get(q);
		let k = 0;
		v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
		for (let q = 1; q < len; q++) {
			let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
			while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
			k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
		}
		k = 0;
		for (let q = 0; q < len; q++) {
			while (z[k + 1] < q) k++;
			d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
		}
		for (let q = 0; q < len; q++) set(q, d[q]);
	};
	for (let i = 0; i < nx; i++) pass(ny, q => grid[q * nx + i], (q, val) => { grid[q * nx + i] = val; });
	for (let j = 0; j < ny; j++) pass(nx, q => grid[j * nx + q], (q, val) => { grid[j * nx + q] = val; });
}

/**
 * Marching squares: the closed contours where the field crosses `level`, inside meaning below it.
 * Edge points are keyed by the grid edge they lie on (an integer: horizontal edges first, then
 * vertical ones), so the pieces join into loops; each key has at most two neighbours, kept in
 * typed arrays (string keys and maps made this step dominate a crafted render, review 0.20.0).
 * The padding keeps the grid's border outside, so every loop closes.
 */
function contours(field: Float64Array, nx: number, ny: number, x0: number, y0: number, level: number, step: number): Pt[][] {
	const cells = nx * ny;
	const px = new Float64Array(2 * cells), py = new Float64Array(2 * cells);
	const adj = new Int32Array(4 * cells).fill(-1);
	const used: number[] = [];
	const at = (i: number, j: number) => field[j * nx + i];
	const point = (key: number, ax: number, ay: number, fa: number, bx: number, by: number, fb: number): number => {
		if (adj[2 * key] === -1 && adj[2 * key + 1] === -1) {
			const u = fb === fa ? 0.5 : (level - fa) / (fb - fa);
			px[key] = x0 + (ax + u * (bx - ax)) * step;
			py[key] = y0 + (ay + u * (by - ay)) * step;
		}
		return key;
	};
	const link = (a: number, b: number) => {
		if (adj[2 * a] === -1 && adj[2 * a + 1] === -1) used.push(a);
		adj[adj[2 * a] === -1 ? 2 * a : 2 * a + 1] = b;
	};
	const join = (a: number, b: number) => { link(a, b); link(b, a); };
	for (let j = 0; j < ny - 1; j++) {
		for (let i = 0; i < nx - 1; i++) {
			const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
			const kase = (a < level ? 8 : 0) | (b < level ? 4 : 0) | (c < level ? 2 : 0) | (d < level ? 1 : 0);
			if (kase === 0 || kase === 15) continue;
			const top = () => point(j * nx + i, i, j, a, i + 1, j, b);
			const right = () => point(cells + j * nx + i + 1, i + 1, j, b, i + 1, j + 1, c);
			const bottom = () => point((j + 1) * nx + i, i, j + 1, d, i + 1, j + 1, c);
			const left = () => point(cells + j * nx + i, i, j, a, i, j + 1, d);
			const centreIn = (a + b + c + d) / 4 < level;
			switch (kase) {
				case 1: case 14: join(left(), bottom()); break;
				case 2: case 13: join(bottom(), right()); break;
				case 3: case 12: join(left(), right()); break;
				case 4: case 11: join(top(), right()); break;
				case 6: case 9: join(top(), bottom()); break;
				case 7: case 8: join(top(), left()); break;
				case 5: // b and d inside
					if (centreIn) { join(top(), left()); join(bottom(), right()); } else { join(top(), right()); join(left(), bottom()); }
					break;
				case 10: // a and c inside
					if (centreIn) { join(top(), right()); join(left(), bottom()); } else { join(top(), left()); join(bottom(), right()); }
					break;
			}
		}
	}
	const loops: Pt[][] = [];
	const done = new Uint8Array(2 * cells);
	for (const start of used) {
		if (done[start]) continue;
		const loop: Pt[] = [];
		let prev = -1, cur = start;
		while (cur >= 0 && !done[cur]) {
			done[cur] = 1;
			loop.push({ x: px[cur], y: py[cur] });
			const n0 = adj[2 * cur], n1 = adj[2 * cur + 1];
			const step = n0 >= 0 && n0 !== prev && !done[n0] ? n0 : n1 >= 0 && n1 !== prev && !done[n1] ? n1 : -1;
			prev = cur;
			cur = step;
		}
		if (loop.length >= 3) loops.push(loop);
	}
	return loops;
}

/** Whether `p` lies inside the polygon (even-odd rule). */
export function inside(p: Pt, poly: Pt[]): boolean {
	let odd = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i], b = poly[j];
		if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) odd = !odd;
	}
	return odd;
}

/** Only the loops no other loop contains: a hole of the area is filled. */
function outerLoops(loops: Pt[][]): Pt[][] {
	return loops.filter((l, i) => !loops.some((o, k) => k !== i && inside(l[0], o)));
}

/** Douglas-Peucker on an open polyline: the points that keep it within `tol` (iterative). */
function simplify(pts: Pt[], tol: number): Pt[] {
	if (pts.length < 3) return pts;
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const pa = pts[a], pb = pts[b];
		const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1;
		let worst = -1, far = tol;
		for (let i = a + 1; i < b; i++) {
			const d = Math.abs((pts[i].x - pa.x) * dy - (pts[i].y - pa.y) * dx) / len;
			if (d > far) { far = d; worst = i; }
		}
		if (worst >= 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
	}
	return pts.filter((_, i) => keep[i]);
}

/**
 * A closed, smooth SVG path through each loop: the loop thinned to the points that keep it within
 * 0.75 units, then a closed centripetal Catmull-Rom spline as cubic Béziers. Numbers only, one decimal.
 */
export function pathOf(loops: Pt[][]): string {
	const f = (v: number) => (Math.round(v * 10) / 10).toString();
	const parts: string[] = [];
	for (const loop of loops) {
		// Split the closed loop at its first point and the point farthest from it, so both halves are open.
		let far = 0;
		loop.forEach((p, i) => { if (Math.hypot(p.x - loop[0].x, p.y - loop[0].y) > Math.hypot(loop[far].x - loop[0].x, loop[far].y - loop[0].y)) far = i; });
		const pts = [...simplify(loop.slice(0, far + 1), 0.75), ...simplify([...loop.slice(far), loop[0]], 0.75).slice(1, -1)];
		if (pts.length < 3) continue;
		const n = pts.length;
		let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
		// Centripetal Catmull-Rom (alpha 0.5, as d3's curveCatmullRom): with unevenly spaced points a
		// uniform spline overshoots into hooks at sharp corners, the centripetal one does not.
		const l = (a: Pt, b: Pt) => Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y));
		for (let i = 0; i < n; i++) {
			const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
			const l01 = l(p0, p1), l12 = l(p1, p2), l23 = l(p2, p3);
			let c1 = p1, c2 = p2;
			if (l01 > 1e-6) {
				const a = 2 * l01 * l01 + 3 * l01 * l12 + l12 * l12, m = 3 * l01 * (l01 + l12);
				c1 = { x: (p1.x * a - p0.x * l12 * l12 + p2.x * l01 * l01) / m, y: (p1.y * a - p0.y * l12 * l12 + p2.y * l01 * l01) / m };
			}
			if (l23 > 1e-6) {
				const b = 2 * l23 * l23 + 3 * l23 * l12 + l12 * l12, m = 3 * l23 * (l23 + l12);
				c2 = { x: (p2.x * b + p1.x * l23 * l23 - p3.x * l12 * l12) / m, y: (p2.y * b + p1.y * l23 * l23 - p3.y * l12 * l12) / m };
			}
			d += `C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(p2.x)},${f(p2.y)}`;
		}
		parts.push(`${d}Z`);
	}
	return parts.join('');
}
