/**
 * A Wardley map as data, for scripts and agents (`wardley-read`, `wardley-apply`).
 *
 * Reading uses Mermaid's own parser (`@mermaid-js/parser`, the one the renderer uses), so
 * names, pipelines, labels and arrows are exactly what Mermaid draws, and every entry carries
 * its 1-based line in the block. Applying a target model never re-emits the block: it runs
 * the same in-place text edits as the graphical editor, so everything the model does not
 * mention (comments, arrow kinds, label offsets, pipelines) stays byte-identical.
 *
 * The data shape is a public contract, versioned by `SCHEMA` and documented in
 * `docs/wardley-model.md`. Pure: the parser is passed in, nothing here touches Obsidian.
 */
import { CliError } from './cli';
import {
	EditError, Method, addElement, addEvolve, addForce, addLink, addNote, addToPipeline, deleteElement,
	deleteEvolve, deleteForce, deleteNote, editBlocker, inertiaMarkers, setEvolveTarget, setInertiaPosition,
	setForcePosition, setInertia, setLabelOffset, setLink, setMethod, setNotePosition, setPosition,
	setTitle, unlink, LinkKind,
} from './wardley-text';

/** Version of the model shape. Bump on any incompatible change. */
export const SCHEMA = 1;

export type Pair = [number, number];

export interface ModelElement {
	name: string;
	kind: 'anchor' | 'component';
	/** 0..1. A pipeline component has its parent's visibility (that is where Mermaid draws it). */
	visibility: number;
	evolution: number;
	line: number;
	/** Parent component, for a pipeline component. */
	pipeline?: string;
	/** `label [dx, dy]`, map pixels relative to the node. */
	label?: Pair;
	inertia?: true;
	/**
	 * Where the inertia bar is drawn on the evolution axis, present whenever `inertia` is: from
	 * the plugin's `%% mp-inertia` comment, else Mermaid's own default position.
	 */
	inertiaAt?: number;
	/** `inertiaAt` is Mermaid's default (no `%% mp-inertia` comment). */
	inertiaAtDefault?: true;
	method?: Method;
}

export interface ModelLink {
	from: string;
	to: string;
	/** The arrow as written: `->`, `-->`, `-.->`, `+>`, `+<`, `+<>`, `+'label'>`. */
	kind: string;
	/** `; label`, or the inline label of a flow arrow. */
	label?: string;
	/** A flow arrow (`+…`). */
	flow?: true;
	line: number;
}

export interface WardleyModel {
	schema: number;
	/** How the block writes positions. The model is always 0..1. */
	scale: 'decimal' | 'percent';
	title?: string;
	accTitle?: string;
	accDescr?: string;
	size?: { width: number; height: number };
	stages?: { label: string; boundary?: number }[];
	elements: ModelElement[];
	pipelines: { parent: string; children: string[]; line: number }[];
	links: ModelLink[];
	evolves: { name: string; evolution: number; line: number }[];
	notes: { text: string; visibility: number; evolution: number; line: number }[];
	forces: { kind: 'accelerator' | 'deaccelerator'; name: string; visibility: number; evolution: number; line: number }[];
	annotations: { number: number; text: string; visibility: number; evolution: number; line: number }[];
	annotationsBox?: { visibility: number; evolution: number; line: number };
	/** The map parses but is wrong somewhere (line null: the whole map). */
	errors: { line: number | null; message: string }[];
	/** Parsed statements no field of the model covers (expected empty). */
	unsupported: { line: number; text: string }[];
}

/** `parse` of `@mermaid-js/parser`. */
export type ParseFn = (type: 'wardley', text: string) => Promise<any>;

/** Statement types the model covers; anything else Mermaid parses is reported as unsupported. */
const COVERED = new Set(['Anchor', 'Component', 'Pipeline', 'PipelineComponent', 'Link', 'Evolve', 'Note',
	'Accelerator', 'Deaccelerator', 'Annotation', 'Annotations', 'Size', 'Evolution', 'EvolutionStage', 'Label', 'Decorator']);

const lineOf = (node: any): number => (node?.$cstNode?.range?.start?.line ?? -1) + 1;
const round = (v: number) => Math.round(v * 10000) / 10000;

/** Mermaid 12.1's wardley defaults (`getConfigValues`), which Obsidian does not override. */
const MERMAID = { width: 900, padding: 48, nodeRadius: 6 };

/**
 * Where Mermaid 12.1 draws an inertia bar without `%% mp-inertia`, in evolution (0-1): a fixed
 * pixel offset right of the node (more with a build/buy/outsource/market decorator), and a
 * pipeline parent is drawn at the centre of its components, not at its own evolution.
 */
function defaultInertia(el: ModelElement, children: number[], chartWidth: number): number {
	const parent = children.length > 0;
	const x = parent ? (Math.min(...children) + Math.max(...children)) / 2 : el.evolution;
	let offset = parent ? (MERMAID.nodeRadius * 1.6) / 2 + 15 : MERMAID.nodeRadius + 15;
	if (el.method) offset += MERMAID.nodeRadius + 10;
	return round(x + offset / chartWidth);
}

/**
 * Mermaid's parse error as "line L, column C: message" (block-relative, 1-based). An error at
 * the end of the input has no token of its own; it is placed after the last token read.
 */
function parseErrorMessage(e: any, source: string): string {
	const lex = e?.result?.lexerErrors?.[0];
	if (lex) return `line ${lex.line}, column ${lex.column}: ${lex.message}`;
	const p = e?.result?.parserErrors?.[0];
	if (p) {
		const ok = (t: any) => t && Number.isFinite(t.startLine) && t.startLine > 0;
		if (ok(p.token)) return `line ${p.token.startLine}, column ${p.token.startColumn}: ${p.message}`;
		if (ok(p.previousToken)) return `line ${p.previousToken.startLine}, column ${p.previousToken.endColumn + 1}: ${p.message}`;
		return `line ${source.split('\n').length}, column 1: ${p.message}`;
	}
	return e instanceof Error ? e.message : String(e);
}

/** Reads a wardley-beta block. Throws `CliError('parse-error')` when Mermaid cannot parse it. */
export async function readModel(source: string, parse: ParseFn): Promise<WardleyModel> {
	let ast: any;
	try {
		ast = await parse('wardley', source);
	} catch (e) {
		throw new CliError('parse-error', parseErrorMessage(e, source));
	}
	const errors: WardleyModel['errors'] = [];
	const lines = source.split('\n');

	// Scale: Mermaid reads each value on its own (<= 1 decimal, else percent). The map's
	// intended scale is what most of its values use; a value on the other one is an error.
	const raw: number[] = [];
	const collect = (...vs: (number | undefined)[]) => { for (const v of vs) if (typeof v === 'number') raw.push(v); };
	for (const n of [...ast.anchors, ...ast.components, ...ast.notes]) collect(n.visibility, n.evolution);
	for (const n of [...ast.accelerators, ...ast.deaccelerators, ...ast.annotation, ...ast.annotations]) collect(n.x, n.y);
	for (const p of ast.pipelines) for (const c of p.components) collect(c.evolution);
	for (const ev of ast.evolves) collect(ev.target);
	const big = raw.filter(v => v > 1).length;
	const small = raw.filter(v => v > 0 && v <= 1).length;
	const scale: WardleyModel['scale'] = big > small ? 'percent' : 'decimal';

	const coord = (v: number, line: number, what: string): number => {
		if (v > 100) errors.push({ line, message: `${what}: ${v} is outside 0-1; Mermaid refuses the map.` });
		else if (scale === 'decimal' && v > 1) errors.push({ line, message: `${what}: ${v} is outside 0-1; Mermaid reads it as ${v} %.` });
		else if (scale === 'percent' && v > 0 && v <= 1) errors.push({ line, message: `${what}: ${v} in a 0-100 map; Mermaid reads it as ${round(v * 100)} %.` });
		return round(v <= 1 ? v : v / 100);
	};

	const elements: ModelElement[] = [];
	const byName = new Map<string, ModelElement>();
	const declare = (el: ModelElement) => {
		const prev = byName.get(el.name);
		if (prev) errors.push({ line: el.line, message: `"${el.name}" is declared twice (lines ${prev.line} and ${el.line}).` });
		else byName.set(el.name, el);
		elements.push(el);
	};
	const labelOf = (l: any): Pair | undefined => l
		? [(l.negX ? -1 : 1) * l.offsetX, (l.negY ? -1 : 1) * l.offsetY] : undefined;

	for (const a of ast.anchors) {
		const line = lineOf(a);
		declare({ name: a.name, kind: 'anchor', visibility: coord(a.visibility, line, `"${a.name}" visibility`),
			evolution: coord(a.evolution, line, `"${a.name}" evolution`), line });
	}
	for (const c of ast.components) {
		const line = lineOf(c);
		const el: ModelElement = { name: c.name, kind: 'component', visibility: coord(c.visibility, line, `"${c.name}" visibility`),
			evolution: coord(c.evolution, line, `"${c.name}" evolution`), line };
		const label = labelOf(c.label);
		if (label) el.label = label;
		if (c.inertia) el.inertia = true;
		if (c.decorator?.strategy) el.method = c.decorator.strategy;
		declare(el);
	}
	const pipelines: WardleyModel['pipelines'] = [];
	for (const p of ast.pipelines) {
		const line = lineOf(p);
		const parent = byName.get(p.parent);
		if (!parent) errors.push({ line, message: `The pipeline of "${p.parent}" names no declared element; Mermaid refuses the map.` });
		else if (parent.pipeline) errors.push({ line, message: `"${p.parent}" is itself a pipeline component.` });
		if (pipelines.some(q => q.parent === p.parent)) errors.push({ line, message: `"${p.parent}" has two pipelines.` });
		const children: string[] = [];
		for (const c of p.components) {
			const cl = lineOf(c);
			const evolution = coord(c.evolution, cl, `"${c.name}" evolution`);
			children.push(c.name);
			if (!parent) continue;
			const el: ModelElement = { name: c.name, kind: 'component', visibility: parent.visibility, evolution, line: cl, pipeline: p.parent };
			const label = labelOf(c.label);
			if (label) el.label = label;
			declare(el);
		}
		pipelines.push({ parent: p.parent, children, line });
	}

	for (const m of inertiaMarkers(source)) {
		const el = byName.get(m.name);
		if (!el?.inertia) errors.push({ line: m.line, message: `mp-inertia "${m.name}": no component of that name with (inertia).` });
		else el.inertiaAt = coord(m.evolution, m.line, `inertia of "${m.name}"`);
	}
	const chartWidth = (ast.size?.width ?? MERMAID.width) - 2 * MERMAID.padding;
	for (const el of elements) {
		if (!el.inertia || el.inertiaAt !== undefined) continue;
		const kids = elements.filter(e => e.pipeline === el.name).map(e => e.evolution);
		el.inertiaAt = defaultInertia(el, kids, chartWidth);
		el.inertiaAtDefault = true;
	}

	const links: ModelLink[] = [];
	const pairs = new Map<string, number>();
	for (const l of ast.links) {
		const line = lineOf(l);
		const kind: string = l.arrow ?? l.fromPort ?? l.toPort ?? '';
		const link: ModelLink = { from: l.from, to: l.to, kind, line };
		const inline = /^\+'([^']*)'/.exec(kind)?.[1] ?? /^\+"([^"]*)"/.exec(kind)?.[1];
		const label = inline ?? l.linkLabel;
		if (label !== undefined && label !== '') link.label = String(label).trim();
		if (kind.startsWith('+')) link.flow = true;
		for (const end of [l.from, l.to]) {
			if (!byName.has(end)) errors.push({ line, message: `Link ${l.from} ${kind} ${l.to}: "${end}" is not declared.` });
		}
		const key = pairKey(l.from, l.to);
		if (pairs.has(key)) errors.push({ line, message: `"${l.from}" and "${l.to}" are linked twice (lines ${pairs.get(key)} and ${line}).` });
		else pairs.set(key, line);
		links.push(link);
	}

	const evolves: WardleyModel['evolves'] = [];
	for (const ev of ast.evolves) {
		const line = lineOf(ev);
		const el = byName.get(ev.component);
		if (!el) errors.push({ line, message: `evolve "${ev.component}": not declared; Mermaid draws nothing.` });
		else if (el.pipeline) errors.push({ line, message: `evolve "${ev.component}": a pipeline component cannot evolve in Mermaid; it draws nothing.` });
		const prev = evolves.find(x => x.name === ev.component);
		if (prev) errors.push({ line, message: `"${ev.component}" has two evolve lines (${prev.line} and ${line}); Mermaid draws the last.` });
		evolves.push({ name: ev.component, evolution: coord(ev.target, line, `evolve "${ev.component}"`), line });
	}

	const notes = ast.notes.map((n: any) => {
		const line = lineOf(n);
		return { text: n.text, visibility: coord(n.visibility, line, 'note visibility'), evolution: coord(n.evolution, line, 'note evolution'), line };
	});
	const forces: WardleyModel['forces'] = [];
	for (const [kind, list] of [['accelerator', ast.accelerators], ['deaccelerator', ast.deaccelerators]] as const) {
		for (const f of list) {
			const line = lineOf(f);
			forces.push({ kind, name: f.name, visibility: coord(f.x, line, `${kind} "${f.name}"`), evolution: coord(f.y, line, `${kind} "${f.name}"`), line });
		}
	}
	forces.sort((a, b) => a.line - b.line);
	const annotations = ast.annotation.map((a: any) => {
		const line = lineOf(a);
		return { number: a.number, text: a.text, visibility: coord(a.x, line, `annotation ${a.number}`), evolution: coord(a.y, line, `annotation ${a.number}`), line };
	});

	const model: WardleyModel = {
		schema: SCHEMA, scale,
		elements, pipelines, links, evolves, notes, forces, annotations,
		errors: [], unsupported: [],
	};
	if (ast.title) model.title = String(ast.title).trim();
	if (ast.accTitle) model.accTitle = String(ast.accTitle).trim();
	if (ast.accDescr) model.accDescr = String(ast.accDescr).trim();
	if (ast.size) model.size = { width: ast.size.width, height: ast.size.height };
	if (ast.evolution) {
		model.stages = ast.evolution.stages.map((s: any) => {
			const stage: { label: string; boundary?: number } = { label: s.secondName ? `${s.name.trim()} / ${s.secondName.trim()}` : s.name.trim() };
			if (s.boundary !== undefined) stage.boundary = s.boundary;
			return stage;
		});
	}
	if (ast.annotations.length) {
		const b = ast.annotations[0];
		const line = lineOf(b);
		model.annotationsBox = { visibility: coord(b.x, line, 'annotations box'), evolution: coord(b.y, line, 'annotations box'), line };
	}

	// Every top-level statement of the parse tree is either covered above or listed here.
	for (const child of ast.$cstNode?.content ?? []) {
		if (child.hidden) continue;
		const node = child.astNode;
		if (!node || node === ast || COVERED.has(node.$type)) continue;
		const line = (child.range?.start?.line ?? 0) + 1;
		if (!model.unsupported.some(u => u.line === line)) model.unsupported.push({ line, text: lines[line - 1]?.trim() ?? '' });
	}

	elements.sort((a, b) => a.line - b.line);
	model.errors = errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	return model;
}

/** How Mermaid 12.1 draws an arrow (`populateDb`): dashed or not, and its flow heads. */
function rendering(arrow: string): string {
	const dashed = arrow.includes('-.->') || arrow.includes('.-.');
	const flow = !arrow.startsWith('+') ? 'none' : arrow.includes('<>') ? 'both' : arrow.includes('<') ? 'backward' : arrow.includes('>') ? 'forward' : 'none';
	return `${dashed ? 'dashed' : 'solid'} ${flow}`;
}
/** The inline label of a flow arrow (`+'x'>`), or undefined. */
const inlineLabel = (arrow: string) => /^\+'([^']*)'/.exec(arrow)?.[1];
/** The same arrow without its inline label: `+'x'<` becomes `+<`. */
const portForm = (arrow: string) => arrow.replace(/^\+'[^']*'/, '+');

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** The drawing of an arrow as the editor writes it (`setLink`). */
function linkKindOf(arrow: string): LinkKind {
	const bare = arrow.replace(/^\+'[^']*'|^\+"[^"]*"/, '+');
	if (bare.startsWith('+')) return bare.includes('<>') ? 'both' : bare.includes('<') ? 'backward' : 'forward';
	return bare.includes('.') ? 'dashed' : 'line';
}

// ---- apply --------------------------------------------------------------------------

export interface Change {
	op: 'add' | 'move' | 'update' | 'remove';
	what: string;
	from?: unknown;
	to?: unknown;
	/** 1-based line: in the original block, for an addition in the new one. */
	line?: number;
}
export interface Conflict { what: string; message: string; line?: number }
export interface ApplyResult { changes: Change[]; conflicts: Conflict[]; source: string }
export interface ApplyOptions { tolerance?: number; allowDelete?: boolean }

const METHODS = ['build', 'buy', 'outsource', 'market'];
const KINDS = ['anchor', 'component'];
const FORCE_KINDS = ['accelerator', 'deaccelerator'];

/** The target model, checked field by field; only what `apply` uses. */
interface Target {
	title?: string;
	elements?: { name: string; kind?: 'anchor' | 'component'; visibility?: number; evolution: number; pipeline?: string | null; label?: Pair | null; inertia?: boolean; inertiaAt?: number | null; method?: Method | null }[];
	links?: { from: string; to: string; kind?: string; label?: string | null }[];
	evolves?: { name: string; evolution: number }[];
	notes?: { text: string; visibility: number; evolution: number }[];
	forces?: { kind: 'accelerator' | 'deaccelerator'; name: string; visibility: number; evolution: number }[];
}

function checkTarget(t: any): Target {
	const bad = (msg: string): never => { throw new CliError('bad-model', msg); };
	if (!t || typeof t !== 'object' || Array.isArray(t)) bad('model must be a JSON object.');
	const str = (v: any, what: string) => { if (typeof v !== 'string' || !v.trim()) bad(`${what} must be a non-empty string.`); };
	const num = (v: any, what: string) => { if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${what} must be a number.`); };
	const arr = (k: string) => { if (t[k] !== undefined && !Array.isArray(t[k])) bad(`${k} must be an array.`); return (t[k] ?? []) as any[]; };
	if (t.title !== undefined && typeof t.title !== 'string') bad('title must be a string.');
	arr('elements').forEach((e, i) => {
		str(e?.name, `elements[${i}].name`);
		num(e.evolution, `elements[${i}].evolution`);
		if (e.pipeline != null) str(e.pipeline, `elements[${i}].pipeline`);
		if (e.visibility !== undefined) num(e.visibility, `elements[${i}].visibility`);
		if (e.kind !== undefined && !KINDS.includes(e.kind)) bad(`elements[${i}].kind must be anchor or component.`);
		if (e.label != null && !(Array.isArray(e.label) && e.label.length === 2 && e.label.every((v: any) => Number.isFinite(v)))) bad(`elements[${i}].label must be [dx, dy].`);
		if (e.inertia !== undefined && typeof e.inertia !== 'boolean') bad(`elements[${i}].inertia must be a boolean.`);
		if (e.inertiaAt != null) num(e.inertiaAt, `elements[${i}].inertiaAt`);
		if (e.method != null && !METHODS.includes(e.method)) bad(`elements[${i}].method must be one of ${METHODS.join('|')}.`);
	});
	arr('links').forEach((l, i) => {
		str(l?.from, `links[${i}].from`); str(l.to, `links[${i}].to`);
		if (l.kind !== undefined && !/^(->|-->|-\.->|\+<>|\+<|\+>|\+'[^']*'(?:<>|<|>))$/.test(l.kind)) bad(`links[${i}].kind "${l.kind}" is not an arrow.`);
		if (l.label != null && typeof l.label !== 'string') bad(`links[${i}].label must be a string.`);
	});
	arr('evolves').forEach((e, i) => { str(e?.name, `evolves[${i}].name`); num(e.evolution, `evolves[${i}].evolution`); });
	arr('notes').forEach((n, i) => { str(n?.text, `notes[${i}].text`); num(n.visibility, `notes[${i}].visibility`); num(n.evolution, `notes[${i}].evolution`); });
	arr('forces').forEach((f, i) => {
		if (!FORCE_KINDS.includes(f?.kind)) bad(`forces[${i}].kind must be accelerator or deaccelerator.`);
		str(f.name, `forces[${i}].name`); num(f.visibility, `forces[${i}].visibility`); num(f.evolution, `forces[${i}].evolution`);
	});
	return t as Target;
}

const at2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Brings `source` in line with `target` by in-place edits. Sections absent from the target
 * are left alone; within an entry, an absent field keeps the text's value. Removals are
 * applied only with `allowDelete`, otherwise reported as conflicts. Throws `CliError` when
 * the block cannot be edited or the result does not parse.
 */
export async function applyModel(source: string, targetIn: unknown, parse: ParseFn, opts: ApplyOptions = {}): Promise<ApplyResult> {
	const tol = opts.tolerance ?? 0.01;
	const target = checkTarget(targetIn);
	const blocker = editBlocker(source);
	if (blocker) throw new CliError('not-editable', blocker);
	const cur = await readModel(source, parse);

	let s = source;
	const changes: Change[] = [];
	const conflicts: Conflict[] = [];
	/** Additions get their line from the result, keyed by section and identity. */
	const added: { change: Change; find: (m: WardleyModel) => number | undefined }[] = [];
	const edit = (what: string, line: number | undefined, f: (src: string) => string): boolean => {
		try {
			s = f(s);
			return true;
		} catch (e) {
			if (!(e instanceof EditError)) throw e;
			conflicts.push({ what, message: e.message, ...(line ? { line } : {}) });
			return false;
		}
	};
	const differs = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) > tol;
	const notInTarget = (what: string, line: number, remove: (src: string) => string) => {
		if (!opts.allowDelete) {
			conflicts.push({ what, message: 'In the text, not in the model; pass allow-delete to remove it.', line });
		} else if (edit(what, line, remove)) {
			changes.push({ op: 'remove', what, line });
		}
	};

	if (typeof target.title === 'string' && target.title.trim() !== (cur.title ?? '')) {
		edit('title', undefined, src => setTitle(src, target.title!));
		changes.push({ op: 'update', what: 'title', from: cur.title ?? null, to: target.title.trim() || null });
	}

	// ---- elements: top level first, so a new pipeline's parent exists before its children
	const curEl = new Map(cur.elements.map(e => [e.name, e]));
	const parents = new Set(cur.pipelines.filter(p => p.children.length > 0).map(p => p.parent));
	const tEls = target.elements;
	const tByName = new Map((tEls ?? []).map(e => [e.name.trim(), e]));
	const ordered = [...(tEls ?? [])].sort((a, b) => Number(!!a.pipeline) - Number(!!b.pipeline));
	for (const t of ordered) {
		const name = t.name.trim();
		const c = curEl.get(name);
		const kind = t.kind ?? c?.kind ?? 'component';
		const what = `${kind} ${name}`;
		const parentVis = (p: string) => tByName.get(p)?.visibility ?? curEl.get(p)?.visibility;
		if (!c) {
			if (!t.pipeline && t.visibility === undefined) {
				conflicts.push({ what, message: 'A new element needs a visibility; not added.' });
				continue;
			}
			const ok = t.pipeline
				? edit(what, undefined, src => addToPipeline(src, t.pipeline!, name, t.evolution))
				: edit(what, undefined, src => addElement(src, kind, name, t.visibility!, t.evolution));
			if (!ok) continue;
			const change: Change = { op: 'add', what, to: t.pipeline ? [parentVis(t.pipeline) ?? null, at2(t.evolution)] : [at2(t.visibility!), at2(t.evolution)] };
			changes.push(change);
			added.push({ change, find: m => m.elements.find(e => e.name === name)?.line });
			if (t.pipeline && differs(t.visibility, parentVis(t.pipeline))) {
				conflicts.push({ what, message: `A pipeline component sits at its parent's visibility (${parentVis(t.pipeline)}), not ${t.visibility}.` });
			}
			if (t.label && kind === 'component') edit(what, undefined, src => setLabelOffset(src, name, t.label![0], t.label![1]));
			if (t.inertia && kind === 'component' && !t.pipeline) edit(what, undefined, src => setInertia(src, name, true));
			if (t.method && kind === 'component') edit(what, undefined, src => setMethod(src, name, t.method!));
			continue;
		}
		if (kind !== c.kind) {
			conflicts.push({ what, message: `Written as ${c.kind}, the model has ${kind}; the kind is not changed.`, line: c.line });
			continue;
		}
		// No `pipeline` key keeps the text's membership; only a present key that differs is a conflict.
		if (t.pipeline !== undefined && (t.pipeline ?? undefined) !== c.pipeline) {
			conflicts.push({ what, message: c.pipeline
				? `In the pipeline of "${c.pipeline}" in the text, ${t.pipeline ? `of "${t.pipeline}"` : 'top level'} in the model; not moved between pipelines.`
				: `Top level in the text, in the pipeline of "${t.pipeline}" in the model; not moved into a pipeline.`, line: c.line });
			continue;
		}
		if (c.pipeline) {
			if (differs(t.evolution, c.evolution) && edit(what, c.line, src => setPosition(src, name, 0, t.evolution))) {
				changes.push({ op: 'move', what, from: [c.visibility, c.evolution], to: [c.visibility, at2(t.evolution)], line: c.line });
			}
			const pv = parentVis(c.pipeline);
			if (differs(t.visibility, pv)) {
				conflicts.push({ what, message: `A pipeline component sits at its parent's visibility (${pv}), not ${t.visibility}; move the parent instead.`, line: c.line });
			}
		} else if (differs(t.visibility, c.visibility) || (differs(t.evolution, c.evolution) && !parents.has(name))) {
			// A pipeline parent is drawn at the centre of its components, so its own evolution
			// draws nothing and a model taken from a drawing cannot know it: left as written.
			const v = differs(t.visibility, c.visibility) ? t.visibility! : c.visibility;
			const e = differs(t.evolution, c.evolution) && !parents.has(name) ? t.evolution : c.evolution;
			if (edit(what, c.line, src => setPosition(src, name, v, e))) {
				changes.push({ op: 'move', what, from: [c.visibility, c.evolution], to: [at2(v), at2(e)], line: c.line });
			}
		}
		if (t.label !== undefined) {
			const want = t.label ? [Math.round(t.label[0]), Math.round(t.label[1])] : null;
			if (c.kind === 'anchor') {
				if (want) conflicts.push({ what, message: 'Anchors have no label offset in wardley-beta.', line: c.line });
			} else if (want && (!c.label || want[0] !== c.label[0] || want[1] !== c.label[1])) {
				if (edit(what, c.line, src => setLabelOffset(src, name, want[0], want[1]))) {
					changes.push({ op: 'update', what: `${what} label`, from: c.label ?? null, to: want, line: c.line });
				}
			} else if (!want && c.label) {
				conflicts.push({ what, message: 'Removing a label offset is not supported; it stays.', line: c.line });
			}
		}
		if (t.inertia !== undefined && t.inertia !== !!c.inertia) {
			if (edit(what, c.line, src => setInertia(src, name, t.inertia!))) {
				changes.push({ op: 'update', what: `${what} inertia`, from: !!c.inertia, to: t.inertia, line: c.line });
			}
		}
		if (t.method !== undefined && (t.method ?? undefined) !== c.method) {
			if (edit(what, c.line, src => setMethod(src, name, t.method ?? null))) {
				changes.push({ op: 'update', what: `${what} method`, from: c.method ?? null, to: t.method ?? null, line: c.line });
			}
		}
	}

	// ---- links, by the unordered pair of names
	if (target.links) {
		const curLinks = new Map(cur.links.map(l => [pairKey(l.from, l.to), l]));
		const seen = new Set<string>();
		for (const t of target.links) {
			const from = t.from.trim(), to = t.to.trim();
			const key = pairKey(from, to);
			seen.add(key);
			const c = curLinks.get(key);
			const what = `link ${from} -> ${to}`;
			const inline = t.kind !== undefined ? inlineLabel(t.kind) : undefined;
			// No `label` key: the inline label of the model's arrow, if it has one, else keep.
			const label = t.label !== undefined ? (t.label ?? '').trim() : inline;
			/** The model's arrow as given, unless its inline label would contradict `label`. */
			const arrowFor = (arrow: string, lab: string) => (inlineLabel(arrow) !== undefined && inlineLabel(arrow) !== lab ? portForm(arrow) : arrow);
			if (!c) {
				if (!edit(what, undefined, src => addLink(src, from, to))) continue;
				if ((t.kind && t.kind !== '->') || label) {
					const arrow = arrowFor(t.kind ?? '->', label ?? '');
					edit(what, undefined, src => setLink(src, from, to, linkKindOf(arrow), label ?? '', arrow));
				}
				const change: Change = { op: 'add', what: `link ${from} ${t.kind ?? '->'} ${to}${label && !inline ? `; ${label}` : ''}` };
				changes.push(change);
				added.push({ change, find: m => m.links.find(l => pairKey(l.from, l.to) === key)?.line });
				continue;
			}
			if (c.from !== from) {
				conflicts.push({ what, message: `Written as ${c.from} ${c.kind} ${c.to}; the direction is not changed.`, line: c.line });
			}
			// A kind counts as changed only when Mermaid draws it differently (`->` and `-->` are the same line).
			const kindChange = t.kind !== undefined && rendering(t.kind) !== rendering(c.kind);
			const labelChange = label !== undefined && label !== (c.label ?? '');
			if (!kindChange && !labelChange) continue;
			const newLabel = labelChange ? label! : (c.label ?? '');
			// A label change alone keeps the arrow as written (an inline-label flow becomes its port form plus `; label`).
			const arrow = kindChange ? arrowFor(t.kind!, newLabel) : (inlineLabel(c.kind) !== undefined ? portForm(c.kind) : c.kind);
			if (edit(what, c.line, src => setLink(src, c.from, c.to, linkKindOf(arrow), newLabel, arrow))) {
				changes.push({ op: 'update', what: `link ${c.from} ${c.kind} ${c.to}`,
					from: { kind: c.kind, label: c.label ?? '' }, to: { kind: kindChange ? t.kind : c.kind, label: newLabel }, line: c.line });
			}
		}
		for (const c of cur.links) {
			if (!seen.has(pairKey(c.from, c.to))) notInTarget(`link ${c.from} ${c.kind} ${c.to}`, c.line, src => unlink(src, c.from, c.to));
		}
	}

	// ---- evolve arrows, by name
	if (target.evolves) {
		const curEv = new Map(cur.evolves.map(e => [e.name, e]));
		const seen = new Set<string>();
		for (const t of target.evolves) {
			const name = t.name.trim();
			seen.add(name);
			const c = curEv.get(name);
			const what = `evolve ${name}`;
			if (!c) {
				if (edit(what, undefined, src => addEvolve(src, name, t.evolution))) {
					const change: Change = { op: 'add', what, to: at2(t.evolution) };
					changes.push(change);
					added.push({ change, find: m => m.evolves.find(e => e.name === name)?.line });
				}
			} else if (differs(t.evolution, c.evolution) && edit(what, c.line, src => setEvolveTarget(src, name, t.evolution))) {
				changes.push({ op: 'move', what, from: c.evolution, to: at2(t.evolution), line: c.line });
			}
		}
		for (const c of cur.evolves) if (!seen.has(c.name)) notInTarget(`evolve ${c.name}`, c.line, src => deleteEvolve(src, c.name));
	}

	// ---- notes, by their exact text
	if (target.notes) {
		const seen = new Set<string>();
		for (const t of target.notes) {
			const text = t.text.trim();
			seen.add(text);
			const c = cur.notes.find(n => n.text === text);
			const what = `note "${text}"`;
			if (!c) {
				if (edit(what, undefined, src => addNote(src, text, t.visibility, t.evolution))) {
					const change: Change = { op: 'add', what, to: [at2(t.visibility), at2(t.evolution)] };
					changes.push(change);
					added.push({ change, find: m => m.notes.find(n => n.text === text)?.line });
				}
			} else if ((differs(t.visibility, c.visibility) || differs(t.evolution, c.evolution))
				&& edit(what, c.line, src => setNotePosition(src, text, t.visibility, t.evolution))) {
				changes.push({ op: 'move', what, from: [c.visibility, c.evolution], to: [at2(t.visibility), at2(t.evolution)], line: c.line });
			}
		}
		for (const c of cur.notes) if (!seen.has(c.text)) notInTarget(`note "${c.text}"`, c.line, src => deleteNote(src, c.text));
	}

	// ---- accelerators and deaccelerators, by kind and name
	if (target.forces) {
		const seen = new Set<string>();
		for (const t of target.forces) {
			const name = t.name.trim();
			seen.add(`${t.kind} ${name}`);
			const c = cur.forces.find(f => f.kind === t.kind && f.name === name);
			const what = `${t.kind} ${name}`;
			if (!c) {
				if (edit(what, undefined, src => addForce(src, t.kind, name, t.visibility, t.evolution))) {
					const change: Change = { op: 'add', what, to: [at2(t.visibility), at2(t.evolution)] };
					changes.push(change);
					added.push({ change, find: m => m.forces.find(f => f.kind === t.kind && f.name === name)?.line });
				}
			} else if ((differs(t.visibility, c.visibility) || differs(t.evolution, c.evolution))
				&& edit(what, c.line, src => setForcePosition(src, t.kind, name, t.visibility, t.evolution))) {
				changes.push({ op: 'move', what, from: [c.visibility, c.evolution], to: [at2(t.visibility), at2(t.evolution)], line: c.line });
			}
		}
		for (const c of cur.forces) if (!seen.has(`${c.kind} ${c.name}`)) notInTarget(`${c.kind} ${c.name}`, c.line, src => deleteForce(src, c.kind, c.name));
	}

	// ---- element removals last (they take their links and evolve arrow with them);
	// pipeline components before their parents
	if (tEls) {
		const gone = cur.elements.filter(e => !tByName.has(e.name)).sort((a, b) => Number(!!b.pipeline) - Number(!!a.pipeline));
		for (const c of gone) {
			if (cur.elements.filter(e => e.name === c.name).length > 1) continue;  // already an error in the read
			notInTarget(`${c.kind} ${c.name}`, c.line, src => deleteElement(src, c.name));
		}
	}

	// ---- inertia bar positions (`%% mp-inertia`), against the map as edited so far, where
	// the default position already reflects any move: written only when the bar moves
	if (tEls?.some(t => typeof t.inertiaAt === 'number')) {
		let mid: WardleyModel;
		try {
			mid = await readModel(s, parse);
		} catch (e) {
			throw new CliError('invalid-result', `The edited map does not parse, nothing was written (${e instanceof Error ? e.message : e}).`);
		}
		for (const t of tEls) {
			if (typeof t.inertiaAt !== 'number' || t.inertia === false) continue;
			const name = t.name.trim();
			const m = mid.elements.find(e => e.name === name);
			if (!m) continue;
			const what = `${m.kind} ${name}`;
			if (!m.inertia) {
				conflicts.push({ what, message: 'inertiaAt given, but the element has no (inertia); pass inertia: true.', line: m.line });
			} else if (differs(t.inertiaAt, m.inertiaAt) && edit(what, m.line, src => setInertiaPosition(src, name, t.inertiaAt!))) {
				changes.push({ op: 'update', what: `${what} inertia position`, from: m.inertiaAt, to: at2(t.inertiaAt), line: m.line });
			}
		}
	}

	let result: WardleyModel;
	try {
		result = await readModel(s, parse);
	} catch (e) {
		throw new CliError('invalid-result', `The edited map does not parse, nothing was written (${e instanceof Error ? e.message : e}).`);
	}
	for (const a of added) {
		const line = a.find(result);
		if (line) a.change.line = line;
	}
	return { changes, conflicts, source: s };
}
