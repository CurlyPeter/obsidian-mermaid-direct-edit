import { describe, expect, it } from 'vitest';
import { EditError, getLink, setLink, addForce, addToPipeline, deleteForce, deletePipeline, pipelineOf, renameForce, setForcePosition, shiftPipeline, inertiaPositions, setInertiaPosition, setNotePosition, addElement, addEvolve, addLink, addNote, declaredPositions, deleteElement, deleteEvolve, hasInertia, setInertia, formatName, getPosition, nameSpans, relink, rename, setEvolveTarget, setLabelOffset, setPosition, unlink } from './wardley-text';

const MAP = [
	'wardley-beta',
	'title Tea Shop Value Chain',
	'',
	'anchor Business [0.95, 0.63]',
	'component Cup of Tea [0.79, 0.61]',
	'component Hot Water [0.52, 0.80] label [10, -5] (build)',
	'component Kettle [0.43, 0.35]',
	'component "Käse" [0.20, 0.20]',
	'',
	'Business -> Cup of Tea',
	'Cup of Tea -> Hot Water; needs',
	"Hot Water +'heat'> Kettle",
	'Kettle -.-> "Käse"',
	'',
	'evolve Kettle 0.62',
	'pipeline Kettle {',
	'  component Electric [0.60]',
	'}',
	'note "Kettle is not renamed inside notes" [0.30, 0.49]',
].join('\n');

describe('formatName', () => {
	it('writes grammar-valid names bare', () => {
		expect(formatName('Cup of Tea')).toBe('Cup of Tea');
		expect(formatName('end-user')).toBe('end-user');
	});
	it('quotes what the bare grammar rejects', () => {
		expect(formatName('Käse')).toBe('"Käse"');
		expect(formatName('A.B')).toBe('"A.B"');
		expect(formatName('title thing')).toBe('"title thing"');
		expect(formatName('say "hi"')).toBe(`'say "hi"'`);
	});
	it('refuses what cannot be written', () => {
		expect(() => formatName('  ')).toThrow(EditError);
		expect(() => formatName(`a"b'c`)).toThrow(EditError);
	});
});

describe('nameSpans', () => {
	it('finds declaration, link ends, evolve and pipeline names', () => {
		expect(nameSpans('component Hot Water [0.52, 0.80] (build)').map(s => [s.name, s.declaration])).toEqual([['Hot Water', true]]);
		expect(nameSpans('Cup of Tea -> Hot Water; needs').map(s => s.name)).toEqual(['Cup of Tea', 'Hot Water']);
		expect(nameSpans("Hot Water +'heat'> Kettle").map(s => s.name)).toEqual(['Hot Water', 'Kettle']);
		expect(nameSpans('end-user -.-> "A.B"').map(s => s.name)).toEqual(['end-user', 'A.B']);
		expect(nameSpans('evolve Cup of Tea 0.8').map(s => s.name)).toEqual(['Cup of Tea']);
		expect(nameSpans('pipeline Kettle {').map(s => s.name)).toEqual(['Kettle']);
	});
	it('ignores lines without element names', () => {
		for (const l of ['title A -> B', 'note "A -> B" [0.1, 0.1]', 'annotation 1,[0.1, 0.1] "x"', 'evolution A -> B -> C', '%% A -> B']) {
			expect(nameSpans(l)).toEqual([]);
		}
	});
});

describe('getPosition', () => {
	it('reads [visibility, evolution], and evolution alone for a pipeline child', () => {
		expect(getPosition(MAP, 'Business')).toEqual({ visibility: 0.95, evolution: 0.63 });
		expect(getPosition(MAP, 'Käse')).toEqual({ visibility: 0.2, evolution: 0.2 });
		expect(getPosition(MAP, 'Electric')).toEqual({ evolution: 0.6 });
	});
});

describe('setPosition', () => {
	it('rewrites both coordinates of a component and keeps the rest of the line', () => {
		const out = setPosition(MAP, 'Hot Water', 0.6, 0.751);
		expect(out).toContain('component Hot Water [0.60, 0.75] label [10, -5] (build)');
		expect(out.split('\n').length).toBe(MAP.split('\n').length);
	});
	it('moves anchors and quoted names', () => {
		expect(setPosition(MAP, 'Business', 0.9, 0.5)).toContain('anchor Business [0.90, 0.50]');
		expect(setPosition(MAP, 'Käse', 0.3, 0.4)).toContain('component "Käse" [0.30, 0.40]');
	});
	it('clamps to the map', () => {
		expect(setPosition(MAP, 'Kettle', 1.4, -0.2)).toContain('component Kettle [1.00, 0.00]');
	});
	it('keeps a pipeline child to its single evolution value', () => {
		expect(setPosition(MAP, 'Electric', 0.9, 0.7)).toContain('  component Electric [0.70]');
	});
	it('refuses unknown and duplicate names', () => {
		expect(() => setPosition(MAP, 'Nope', 0.5, 0.5)).toThrow(/not declared/);
		expect(() => setPosition(MAP + '\ncomponent Kettle [0.1, 0.1]', 'Kettle', 0.5, 0.5)).toThrow(/declared 2 times/);
	});
});

describe('setLabelOffset', () => {
	it('adds an offset right after the position, before a decorator', () => {
		expect(setLabelOffset(MAP, 'Kettle', 12.4, -20.6)).toContain('component Kettle [0.43, 0.35] label [12, -21]');
		const deco = setLabelOffset(MAP.replace('component Kettle [0.43, 0.35]', 'component Kettle [0.43, 0.35] (build)'), 'Kettle', 5, 5);
		expect(deco).toContain('component Kettle [0.43, 0.35] label [5, 5] (build)');
	});
	it('replaces an existing offset and keeps the rest of the line', () => {
		expect(setLabelOffset(MAP, 'Hot Water', -30, 4)).toContain('component Hot Water [0.52, 0.80] label [-30, 4] (build)');
	});
	it('works for quoted names and pipeline children', () => {
		expect(setLabelOffset(MAP, 'Käse', 1, 2)).toContain('component "Käse" [0.20, 0.20] label [1, 2]');
		expect(setLabelOffset(MAP, 'Electric', -10, 0)).toContain('  component Electric [0.60] label [-10, 0]');
	});
	it('refuses anchors', () => {
		expect(() => setLabelOffset(MAP, 'Business', 5, 5)).toThrow(/anchor/);
	});
});

describe('setEvolveTarget', () => {
	it('rewrites only the target number, clamped and rounded', () => {
		expect(setEvolveTarget(MAP, 'Kettle', 0.777)).toContain('evolve Kettle 0.78');
		expect(setEvolveTarget(MAP, 'Kettle', 1.3)).toContain('evolve Kettle 1.00');
		expect(setEvolveTarget(MAP, 'Kettle', 0.5).split('\n').length).toBe(MAP.split('\n').length);
	});
	it('handles quoted names and refuses missing or duplicate arrows', () => {
		expect(setEvolveTarget(MAP + '\nevolve "Käse" 0.5', 'Käse', 0.6)).toContain('evolve "Käse" 0.60');
		expect(() => setEvolveTarget(MAP, 'Hot Water', 0.6)).toThrow(/no evolve/);
		expect(() => setEvolveTarget(MAP + '\nevolve Kettle 0.9', 'Kettle', 0.6)).toThrow(/2 evolve/);
	});
});

describe('relink', () => {
	it('moves the target end and keeps arrow and label', () => {
		const out = relink(MAP, 'Cup of Tea', 'Hot Water', 'Hot Water', 'Kettle');
		expect(out).toContain('Cup of Tea -> Kettle; needs');
		expect(out).not.toContain('Cup of Tea -> Hot Water');
	});
	it('moves the source end, also of flows, quoting as needed', () => {
		expect(relink(MAP, 'Hot Water', 'Kettle', 'Hot Water', 'Business')).toContain(`Business +'heat'> Kettle`);
		expect(relink(MAP, 'Business', 'Cup of Tea', 'Business', 'Käse')).toContain('"Käse" -> Cup of Tea');
		expect(relink(MAP, 'Kettle', 'Käse', 'Käse', 'Business')).toContain('Kettle -.-> Business');
	});
	it('finds the link whichever order the caller names its ends', () => {
		expect(relink(MAP, 'Hot Water', 'Cup of Tea', 'Hot Water', 'Kettle')).toContain('Cup of Tea -> Kettle; needs');
	});
	it('refuses self-links, existing links, unknown targets and missing links', () => {
		expect(() => relink(MAP, 'Business', 'Cup of Tea', 'Business', 'Cup of Tea')).toThrow(/itself/);
		expect(() => relink(MAP, 'Business', 'Cup of Tea', 'Business', 'Hot Water')).toThrow(/already linked/);
		expect(() => relink(MAP, 'Business', 'Cup of Tea', 'Cup of Tea', 'Nope')).toThrow(/not declared/);
		expect(() => relink(MAP, 'Business', 'Kettle', 'Kettle', 'Tea')).toThrow(/No link/);
	});
});

describe('getLink / setLink', () => {
	it('reads kind and label of every form', () => {
		expect(getLink(MAP, 'Business', 'Cup of Tea')).toEqual({ from: 'Business', to: 'Cup of Tea', kind: 'line', label: '' });
		expect(getLink(MAP, 'Hot Water', 'Cup of Tea')).toEqual({ from: 'Cup of Tea', to: 'Hot Water', kind: 'line', label: 'needs' });
		expect(getLink(MAP, 'Hot Water', 'Kettle')).toEqual({ from: 'Hot Water', to: 'Kettle', kind: 'forward', label: 'heat' });
		expect(getLink(MAP, 'Kettle', 'Käse')).toMatchObject({ kind: 'dashed', label: '' });
		expect(getLink('wardley-beta\nA +<> B', 'A', 'B').kind).toBe('both');
		expect(getLink('wardley-beta\nA +< B; back', 'B', 'A')).toMatchObject({ kind: 'backward', label: 'back' });
	});
	it('writes kind and label, keeps name order and quoting, drops an empty label', () => {
		expect(setLink(MAP, 'Business', 'Cup of Tea', 'forward', 'orders')).toContain('Business +> Cup of Tea; orders');
		expect(setLink(MAP, 'Cup of Tea', 'Hot Water', 'line', '')).toContain('Cup of Tea -> Hot Water');
		expect(setLink(MAP, 'Cup of Tea', 'Hot Water', 'line', '').split('\n')).not.toContain('Cup of Tea -> Hot Water; needs');
		expect(setLink(MAP, 'Hot Water', 'Kettle', 'backward', 'heat')).toContain('Hot Water +< Kettle; heat');
		expect(setLink(MAP, 'Kettle', 'Käse', 'both', ' two\nlines ')).toContain('Kettle +<> "Käse"; two lines');
		expect(setLink(MAP, 'Kettle', 'Käse', 'dashed', '').split('\n').length).toBe(MAP.split('\n').length);
	});
});

describe('unlink', () => {
	it('removes the whole link line, label and flow included, in either order', () => {
		const out = unlink(MAP, 'Hot Water', 'Cup of Tea');
		expect(out).not.toContain('Cup of Tea -> Hot Water');
		expect(out.split('\n').length).toBe(MAP.split('\n').length - 1);
		expect(unlink(MAP, 'Hot Water', 'Kettle')).not.toContain("+'heat'>");
	});
	it('refuses a missing or duplicated link', () => {
		expect(() => unlink(MAP, 'Business', 'Kettle')).toThrow(/No link/);
		expect(() => unlink(MAP + '\nBusiness -> Cup of Tea', 'Business', 'Cup of Tea')).toThrow(/linked 2 times/);
	});
});

describe('addLink', () => {
	it('adds the link after the last link, quoting as needed', () => {
		const out = addLink(MAP, 'Business', 'Käse');
		const lines = out.split('\n');
		expect(lines[lines.indexOf('Kettle -.-> "Käse"') + 1]).toBe('Business -> "Käse"');
	});
	it('adds after the declarations when there are no links yet', () => {
		const out = addLink('wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.2, 0.2]\n\nnote "x" [0.1, 0.1]', 'A', 'B');
		expect(out).toBe('wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.2, 0.2]\nA -> B\n\nnote "x" [0.1, 0.1]');
	});
	it('refuses self-links, existing links in either direction and unknown names', () => {
		expect(() => addLink(MAP, 'Kettle', 'Kettle')).toThrow(/itself/);
		expect(() => addLink(MAP, 'Cup of Tea', 'Business')).toThrow(/already linked/);
		expect(() => addLink(MAP, 'Kettle', 'Nope')).toThrow(/not declared/);
	});
});

describe('evolve arrows', () => {
	it('deletes and adds them', () => {
		expect(deleteEvolve(MAP, 'Kettle')).not.toContain('evolve Kettle');
		const added = addEvolve(MAP, 'Hot Water', 0.95);
		const lines = added.split('\n');
		expect(lines[lines.indexOf('evolve Kettle 0.62') + 1]).toBe('evolve Hot Water 0.95');
	});
	it('refuses a second arrow, anchors and missing arrows', () => {
		expect(() => addEvolve(MAP, 'Kettle', 0.9)).toThrow(/already has/);
		expect(() => addEvolve(MAP, 'Business', 0.9)).toThrow(/Anchors/);
		expect(() => deleteEvolve(MAP, 'Tea')).toThrow();
	});
});

describe('inertia', () => {
	it('adds (inertia) last, after a decorator, and removes it again', () => {
		const on = setInertia(MAP, 'Hot Water', true);
		expect(on).toContain('component Hot Water [0.52, 0.80] label [10, -5] (build) (inertia)');
		expect(hasInertia(on, 'Hot Water')).toBe(true);
		const off = setInertia(on, 'Hot Water', false);
		expect(off).toBe(MAP);
		expect(setInertia(MAP, 'Kettle', true)).toContain('component Kettle [0.43, 0.35] (inertia)');
	});
	it('reads the bare form and refuses anchors and no-ops', () => {
		expect(hasInertia(MAP.replace('[0.43, 0.35]', '[0.43, 0.35] inertia'), 'Kettle')).toBe(true);
		expect(() => setInertia(MAP, 'Business', true)).toThrow(/Anchors/);
		expect(() => setInertia(MAP, 'Kettle', false)).toThrow(/no inertia/);
	});
});

describe('addElement / deleteElement', () => {
	it('adds a component after the last top-level declaration, not inside a pipeline', () => {
		const out = addElement(MAP, 'component', 'New component', 0.5, 0.5);
		const lines = out.split('\n');
		expect(lines[lines.indexOf('component "Käse" [0.20, 0.20]') + 1]).toBe('component New component [0.50, 0.50]');
		expect(addElement(MAP, 'anchor', 'Kundin', 0.95, 0.4)).toContain('anchor Kundin [0.95, 0.40]');
		expect(addElement('wardley-beta\ntitle T', 'component', 'A', 0.5, 0.5)).toBe('wardley-beta\ntitle T\ncomponent A [0.50, 0.50]');
		expect(() => addElement(MAP, 'component', 'Kettle', 0.5, 0.5)).toThrow(/already exists/);
	});
	it('deletes a component with its links and evolve arrow', () => {
		const out = deleteElement(MAP, 'Hot Water');
		expect(out).not.toMatch(/Hot Water/);
		expect(out).toContain('Kettle -.-> "Käse"');
		expect(out.split('\n').length).toBe(MAP.split('\n').length - 3);
		expect(deleteElement(MAP, 'Käse')).not.toContain('Käse');
	});
	it('also deletes the evolve arrow', () => {
		expect(deleteElement('wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.2, 0.2]\nA -> B\nevolve A 0.8', 'A'))
			.toBe('wardley-beta\ncomponent B [0.2, 0.2]');
	});
	it('refuses a pipeline parent', () => {
		expect(() => deleteElement(MAP, 'Kettle')).toThrow(/pipeline/);
	});
});

describe('addNote / declaredPositions', () => {
	it('adds a note after the last note, keeping trailing blank lines', () => {
		const out = addNote(MAP + '\n\n', 'Check supplier', 0.2, 0.9);
		const lines = out.split('\n');
		expect(lines[lines.findIndex(l => l.startsWith('note "Kettle'))+ 1]).toBe('note "Check supplier" [0.20, 0.90]');
		expect(out.endsWith('\n\n')).toBe(true);
		expect(addNote('wardley-beta\ncomponent A [0.5, 0.5]', 'x', 0.1, 0.1)).toBe('wardley-beta\ncomponent A [0.5, 0.5]\nnote "x" [0.10, 0.10]');
		expect(() => addNote(MAP, 'say "hi"', 0.1, 0.1)).toThrow(/quotes/);
	});
	it('lists declared elements with positions', () => {
		const all = declaredPositions(MAP);
		expect(all.find(p => p.name === 'Business')).toEqual({ name: 'Business', kind: 'anchor', visibility: 0.95, evolution: 0.63 });
		expect(all.find(p => p.name === 'Electric')).toEqual({ name: 'Electric', kind: 'component', evolution: 0.6 });
	});
});

describe('inertia position (plugin extension)', () => {
	const WITH = setInertia(MAP, 'Hot Water', true);
	it('writes the comment after the declaration, replaces it, and reads it back', () => {
		const out = setInertiaPosition(WITH, 'Hot Water', 0.913);
		const lines = out.split('\n');
		expect(lines[lines.findIndex(l => l.startsWith('component Hot Water')) + 1]).toBe('%% mp-inertia Hot Water 0.91');
		const again = setInertiaPosition(out, 'Hot Water', 0.85);
		expect(again.match(/mp-inertia/g)?.length).toBe(1);
		expect(inertiaPositions(again).get('Hot Water')).toBe(0.85);
	});
	it('quotes names, follows renames, and goes away with inertia or the component', () => {
		const q = setInertiaPosition(setInertia(MAP, 'Käse', true), 'Käse', 0.3);
		expect(q).toContain('%% mp-inertia "Käse" 0.30');
		expect(inertiaPositions(q).get('Käse')).toBe(0.3);
		const placed = setInertiaPosition(WITH, 'Hot Water', 0.9);
		expect(rename(placed, 'Hot Water', 'Boiling Water')).toContain('%% mp-inertia Boiling Water 0.90');
		expect(setInertia(placed, 'Hot Water', false)).not.toContain('mp-inertia');
		expect(deleteElement(placed, 'Hot Water')).not.toContain('mp-inertia');
	});
	it('refuses a component without inertia', () => {
		expect(() => setInertiaPosition(MAP, 'Kettle', 0.5)).toThrow(/no inertia/);
	});
});

describe('accelerators and deaccelerators', () => {
	it('adds, moves, renames and deletes them', () => {
		let out = addForce(MAP, 'accelerator', 'Cloud move', 0.3, 0.6);
		expect(out).toContain('accelerator Cloud move [0.30, 0.60]');
		out = addForce(out, 'deaccelerator', 'Habit', 0.2, 0.4);
		const lines = out.split('\n');
		expect(lines[lines.indexOf('accelerator Cloud move [0.30, 0.60]') + 1]).toBe('deaccelerator Habit [0.20, 0.40]');
		out = setForcePosition(out, 'deaccelerator', 'Habit', 0.25, 0.45);
		expect(out).toContain('deaccelerator Habit [0.25, 0.45]');
		out = renameForce(out, 'accelerator', 'Cloud move', 'Käse rush');
		expect(out).toContain('accelerator "Käse rush" [0.30, 0.60]');
		expect(deleteForce(out, 'deaccelerator', 'Habit')).not.toContain('Habit');
	});
	it('keeps kinds apart and refuses duplicates', () => {
		const out = addForce(MAP, 'accelerator', 'X', 0.3, 0.6);
		expect(() => deleteForce(out, 'deaccelerator', 'X')).toThrow(/No deaccelerator/);
		expect(() => addForce(out, 'accelerator', 'X', 0.1, 0.1)).toThrow(/already exists/);
	});
});

describe('pipelines', () => {
	const NO_PIPE = 'wardley-beta\ncomponent K [0.50, 0.40]\ncomponent T [0.80, 0.70]\nK -> T';
	it('creates a pipeline after the parent, then appends to it', () => {
		let out = addToPipeline(NO_PIPE, 'K', 'Electric', 0.6);
		expect(out).toBe('wardley-beta\ncomponent K [0.50, 0.40]\npipeline K {\n  component Electric [0.60]\n}\ncomponent T [0.80, 0.70]\nK -> T');
		out = addToPipeline(out, 'K', 'Campfire', 0.2);
		expect(pipelineOf(out, 'K')).toEqual(['Electric', 'Campfire']);
		expect(() => addToPipeline(out, 'K', 'T', 0.1)).toThrow(/already exists/);
	});
	it('shifts and deletes it; the last component takes the block with it', () => {
		const two = addToPipeline(addToPipeline(NO_PIPE, 'K', 'A', 0.6), 'K', 'B', 0.3);
		expect(shiftPipeline(two, 'K', 0.1)).toContain('component A [0.70]');
		expect(deletePipeline(two, 'K')).toBe(NO_PIPE);
		expect(pipelineOf(deleteElement(two, 'A'), 'K')).toEqual(['B']);
		expect(deleteElement(deleteElement(two, 'A'), 'B')).toBe(NO_PIPE);
	});
	it('refuses anchors', () => {
		expect(() => addToPipeline(MAP, 'Business', 'X', 0.5)).toThrow(/Anchors/);
	});
});

describe('setNotePosition', () => {
	it('moves the note with exactly this text and keeps the rest', () => {
		const out = setNotePosition(MAP, 'Kettle is not renamed inside notes', 0.25, 0.7);
		expect(out).toContain('note "Kettle is not renamed inside notes" [0.25, 0.70]');
		expect(out.split('\n').length).toBe(MAP.split('\n').length);
	});
	it('refuses unknown and duplicated notes', () => {
		expect(() => setNotePosition(MAP, 'Kettle', 0.1, 0.1)).toThrow(/No note/);
		const twice = MAP + '\nnote "Kettle is not renamed inside notes" [0.1, 0.1]';
		expect(() => setNotePosition(twice, 'Kettle is not renamed inside notes', 0.1, 0.1)).toThrow(/2 times/);
	});
});

describe('rename', () => {
	it('renames every reference and nothing else', () => {
		const out = rename(MAP, 'Kettle', 'Electric Kettle');
		expect(out).toContain('component Electric Kettle [0.43, 0.35]');
		expect(out).toContain("Hot Water +'heat'> Electric Kettle");
		expect(out).toContain('Electric Kettle -.-> "Käse"');
		expect(out).toContain('evolve Electric Kettle 0.62');
		expect(out).toContain('pipeline Electric Kettle {');
		expect(out).toContain('note "Kettle is not renamed inside notes"');
	});
	it('does not touch names that only contain the old one', () => {
		expect(() => rename(MAP, 'Tea', 'Leaves')).toThrow(/not declared/);
		const cup = rename(MAP, 'Cup of Tea', 'Mug');
		expect(cup).toContain('component Mug [0.79, 0.61]');
		expect(cup).toContain('Business -> Mug');
		expect(cup).toContain('Mug -> Hot Water; needs');
		expect(cup).toContain('title Tea Shop Value Chain');
	});
	it('quotes a new name the grammar cannot take bare', () => {
		const out = rename(MAP, 'Business', 'Kunde (B2C) & Co.');
		expect(out).toContain('anchor "Kunde (B2C) & Co." [0.95, 0.63]');
		expect(out).toContain('"Kunde (B2C) & Co." -> Cup of Tea');
	});
	it('renames a quoted name to a bare one', () => {
		const out = rename(MAP, 'Käse', 'Cheese');
		expect(out).toContain('component Cheese [0.20, 0.20]');
		expect(out).toContain('Kettle -.-> Cheese');
	});
	it('refuses a name that already exists', () => {
		expect(() => rename(MAP, 'Kettle', 'Hot Water')).toThrow(/already exists/);
	});
});
