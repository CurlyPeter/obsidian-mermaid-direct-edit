import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, TapDetector, fitInside, segmentHit } from './geometry';
import { LINK_GRAB, evolutionAt, linkPart, onTrendShaft, trendTargetX, visibilityAt, xOf, yOf } from './wardley-geometry';

const BOX = { left: 48, right: 1052, top: 48, bottom: 552 };

describe('projection', () => {
	it('maps evolution/visibility to the plot and back', () => {
		expect(xOf(BOX, 0)).toBe(48);
		expect(xOf(BOX, 1)).toBe(1052);
		expect(yOf(BOX, 1)).toBe(48);
		expect(evolutionAt(BOX, xOf(BOX, 0.37))).toBeCloseTo(0.37);
		expect(visibilityAt(BOX, yOf(BOX, 0.81))).toBeCloseTo(0.81);
	});
});

describe('segmentHit', () => {
	it('measures along and across the segment', () => {
		expect(segmentHit({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 4 })).toEqual({ along: 30, perp: 4, len: 100 });
		expect(segmentHit({ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0, y: 0 })).toBeNull();
	});
});

describe('linkPart', () => {
	it('splits a long link into two end bands and a middle', () => {
		expect(linkPart(5, 200)).toBeNull();               // on the node's rim: the node's
		expect(linkPart(LINK_GRAB.from, 200)).toBe(1);
		expect(linkPart(LINK_GRAB.to, 200)).toBe(1);
		expect(linkPart(100, 200)).toBe('middle');
		expect(linkPart(200 - 15, 200)).toBe(2);
	});
	it('caps the end bands at a third of a short link', () => {
		expect(linkPart(20, 45)).toBe('middle');
		expect(linkPart(10, 45)).toBe(1);
	});
});

describe('evolve arrows', () => {
	it('shaft excludes the node and the tip', () => {
		expect(onTrendShaft(5, 200, 0)).toBe(false);
		expect(onTrendShaft(100, 200, 3)).toBe(true);
		expect(onTrendShaft(195, 200, 0)).toBe(false);
		expect(onTrendShaft(100, 200, 9)).toBe(false);
	});
	it('adds the shortening back on the side away from the node', () => {
		expect(trendTargetX(500, 300, 6)).toBe(508);
		expect(trendTargetX(200, 300, 6)).toBe(192);
	});
});

describe('fitInside (the zoom)', () => {
	it('fills the limiting side and keeps the aspect, scaling up as well as down', () => {
		expect(fitInside(1600, 900, 900, 600)).toEqual({ width: 1350, height: 900 });
		expect(fitInside(800, 900, 900, 600)).toEqual({ width: 800, height: 533 });
		expect(fitInside(1600, 900, 90, 60)).toEqual({ width: 1350, height: 900 });
		expect(fitInside(1000, 1000, 300, 1200)).toEqual({ width: 250, height: 1000 });
	});
	it('never exceeds the space it was given', () => {
		// Fractional space too: safe-area padding can leave a fraction of a pixel.
		for (const [aw, ah, w, h] of [[1001, 777, 333, 211], [640, 480, 450, 219], [1919, 1079, 900, 600], [375, 667, 1200, 300], [1000.6, 500.6, 2, 1]]) {
			const r = fitInside(aw, ah, w, h);
			expect(r.width).toBeLessThanOrEqual(aw);
			expect(r.height).toBeLessThanOrEqual(ah);
			// one side touches (within the pixel the floor takes)
			expect(Math.min(aw - r.width, ah - r.height)).toBeLessThan(1 + Math.max(w / h, h / w));
		}
	});
	it('gives the whole space for a size it cannot read', () => {
		expect(fitInside(800, 600, 0, 0)).toEqual({ width: 800, height: 600 });
		expect(fitInside(800, 600, NaN, 10)).toEqual({ width: 800, height: 600 });
		expect(fitInside(-5, 600, 10, 10)).toEqual({ width: 0, height: 0 });
	});
});

describe('TapDetector', () => {
	it('opens on a second tap on the same key within the window only', () => {
		let t = 0;
		const d = new TapDetector(() => t);
		let opened = 0;
		const open = () => { opened++; };
		expect(d.tap('a', open)).toBe(false);
		t += DOUBLE_TAP_MS - 1;
		expect(d.tap('a', open)).toBe(true);
		expect(opened).toBe(1);
		d.tap('a', open); t += DOUBLE_TAP_MS + 1;
		expect(d.tap('a', open)).toBe(false);
		d.tap('b', open); t += 10;
		expect(d.tap('a', open)).toBe(false);
		expect(opened).toBe(1);
	});
	it('lets the system dblclick take a recent tap once', () => {
		let t = 0;
		const d = new TapDetector(() => t);
		d.tap('a', () => undefined);
		t += 100;
		expect(d.take(600)?.key).toBe('a');
		expect(d.take(600)).toBeNull();
		d.tap('b', () => undefined);
		t += 700;
		expect(d.take(600)).toBeNull();
	});
});
