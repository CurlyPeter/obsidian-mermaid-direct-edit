import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, TapDetector, legendSide, segmentHit } from './geometry';
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

describe('legendSide', () => {
	const r = { left: 100, right: 800, bottom: 600, width: 700, height: 500 };
	it('answers only in the very bottom corners', () => {
		expect(legendSide(r, 110, 590)).toBe('left');
		expect(legendSide(r, 790, 590)).toBe('right');
		expect(legendSide(r, 160, 540)).toBeNull();
		expect(legendSide(r, 450, 590)).toBeNull();
		expect(legendSide(r, 110, 300)).toBeNull();
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
