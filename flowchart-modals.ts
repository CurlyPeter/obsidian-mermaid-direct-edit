import { App, DropdownComponent, Modal, Setting } from 'obsidian';
import { Arrow, Head, ShapeType, Stroke } from './flowchart-scan';
import type { Direction, NodeColor } from './flowchart-text';
import { addDeleteButton } from './modals';

/** Shapes offered in the dialog, in the order people reach for them: meaning and geometry. */
export const SHAPE_NAMES: [ShapeType, string][] = [
	['square', 'Rectangle'], ['round', 'Rounded'], ['stadium', 'Stadium'], ['diamond', 'Decision (diamond)'], ['circle', 'Circle'],
	['cylinder', 'Database (cylinder)'], ['subroutine', 'Subroutine'], ['hexagon', 'Hexagon'], ['lean_right', 'Parallelogram'],
	['lean_left', 'Parallelogram (left)'], ['trapezoid', 'Trapezoid'], ['inv_trapezoid', 'Trapezoid (inverted)'],
	['odd', 'Flag'], ['doublecircle', 'Double circle'], ['ellipse', 'Ellipse'],
];

/** The value of the Group dropdown that asks for a new group. */
export const NEW_GROUP = '\u0000new';

/** Node colours: a light fill, a matching outline, and dark text that stays readable in dark themes too. */
export const COLORS: [string, string, NodeColor][] = [
	['orange', 'Orange', { fill: '#ffe8cc', stroke: '#f08c00', color: '#1f2933' }],
	['yellow', 'Yellow', { fill: '#fff3bf', stroke: '#f59f00', color: '#1f2933' }],
	['green', 'Green', { fill: '#d3f9d8', stroke: '#2b8a3e', color: '#1f2933' }],
	['blue', 'Blue', { fill: '#d0ebff', stroke: '#1c7ed6', color: '#1f2933' }],
	['purple', 'Purple', { fill: '#e5dbff', stroke: '#7048e8', color: '#1f2933' }],
	['red', 'Red', { fill: '#ffe3e3', stroke: '#e03131', color: '#1f2933' }],
	['grey', 'Grey', { fill: '#f1f3f5', stroke: '#868e96', color: '#1f2933' }],
];

export const DIRECTIONS: [Direction, string][] = [['TB', 'Top to bottom'], ['LR', 'Left to right'], ['BT', 'Bottom to top'], ['RL', 'Right to left']];

/** Saves on Enter in a text field. */
const onEnter = (input: HTMLInputElement, save: () => void) =>
	input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

export interface NodeDialog {
	id: string;
	label: string;
	/** The bracket shape, or null for the default rectangle. */
	shape: ShapeType | null;
	/** A `@{ shape: … }` value not among the classic shapes, kept unless another is picked. */
	meta: string | null;
	/** Fill of its `style` statement. */
	fill: string | null;
	group: string | null;
	groups: { id: string; title: string; depth: number }[];
}

/** What changed in the node dialog; `group` may be NEW_GROUP. */
export interface NodeChanges { label?: string; shape?: ShapeType; color?: NodeColor | null; group?: string | null }

/** A node: label, shape, color, group, delete. Only what changed is saved, as one edit. */
export class NodeModal extends Modal {
	constructor(app: App, private n: NodeDialog, private onSave: (c: NodeChanges) => void, private onDelete: () => void) {
		super(app);
	}

	onOpen() {
		const n = this.n;
		this.setTitle(`Edit node "${n.label}"`);
		let label = n.label;
		const metaKey = n.meta && !SHAPE_NAMES.some(([t]) => t === n.meta) ? `meta:${n.meta}` : null;
		const shape0 = metaKey ?? n.shape ?? 'square';
		let shape = shape0;
		const color0 = n.fill === null ? 'none' : COLORS.find(([, , c]) => c.fill.toLowerCase() === n.fill!.toLowerCase())?.[0] ?? 'custom';
		let color = color0;
		const group0 = n.group ?? '';
		let group = group0;
		const save = () => {
			this.close();
			const c: NodeChanges = {};
			if (label.trim() && label.trim() !== n.label) c.label = label;
			if (shape !== shape0 && !shape.startsWith('meta:')) c.shape = shape as ShapeType;
			if (color !== color0 && color !== 'custom') c.color = color === 'none' ? null : COLORS.find(([k]) => k === color)![2];
			if (group !== group0) c.group = group || null;
			if (Object.keys(c).length) this.onSave(c);
		};
		new Setting(this.contentEl).setName('Label').addText(t => {
			t.setValue(label).onChange(v => { label = v; });
			onEnter(t.inputEl, save);
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		new Setting(this.contentEl).setName('Shape').addDropdown(d => {
			if (metaKey) d.addOption(metaKey, `${n.meta} (as written)`);
			for (const [t, name] of SHAPE_NAMES) d.addOption(t, name);
			d.setValue(shape).onChange(v => { shape = v; });
		});
		new Setting(this.contentEl).setName('Color').addDropdown(d => {
			d.addOption('none', 'Default');
			for (const [k, name] of COLORS) d.addOption(k, name);
			if (color0 === 'custom') d.addOption('custom', `${n.fill} (as written)`);
			d.setValue(color).onChange(v => { color = v; });
		});
		if (n.groups.length) {
			new Setting(this.contentEl).setName('Group').setDesc('The subgraph the node is drawn in.').addDropdown(d => {
				d.addOption('', 'None');
				for (const g of n.groups) d.addOption(g.id, `${'– '.repeat(g.depth)}${g.title}`);
				d.addOption(NEW_GROUP, 'New group…');
				d.setValue(group).onChange(v => { group = v; });
			});
		} else {
			new Setting(this.contentEl).setName('Group').setDesc('The subgraph the node is drawn in.').addDropdown(d => d
				.addOption('', 'None').addOption(NEW_GROUP, 'New group…').setValue('').onChange(v => { group = v; }));
		}
		const buttons = new Setting(this.contentEl);
		addDeleteButton(buttons, this, 'Really delete, with its edges?', this.onDelete);
		buttons
			.addButton(b => b.setButtonText('Save').setCta().onClick(save))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

const ENDS: [string, string, Head, boolean][] = [
	['arrow', 'Arrow →', 'arrow', false], ['none', 'None (line)', 'none', false], ['both', 'Arrows at both ends ↔', 'arrow', true],
	['circle', 'Circle at the end', 'circle', false], ['circle2', 'Circles at both ends', 'circle', true],
	['cross', 'Cross at the end', 'cross', false], ['cross2', 'Crosses at both ends', 'cross', true],
];
const LINES: [Stroke, string][] = [['normal', 'Solid'], ['dotted', 'Dotted'], ['thick', 'Thick'], ['invisible', 'Invisible (layout only)']];
const LENGTHS: [string, string][] = [['1', 'Normal'], ['2', 'Long'], ['3', 'Longer']];

/** What the link dialog shows and returns: ends by node id. */
export interface LinkDialog { from: string; to: string; arrow: Arrow; label: string; nodes: { id: string; label: string }[] }

/**
 * A link: from, to (swap them with ⇄: reversing loses nothing typed), label, line, ends, minimum
 * length, delete. Everything is saved with Save.
 */
export class EdgeModal extends Modal {
	constructor(
		app: App,
		private e: LinkDialog,
		private onSave: (arrow: Arrow, label: string, from: string, to: string) => void,
		private onDelete: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { arrow, nodes } = this.e;
		const name = (id: string) => nodes.find(n => n.id === id)?.label ?? id;
		this.setTitle(`Edit link "${name(this.e.from)}" → "${name(this.e.to)}"`);
		let label = this.e.label;
		let from = this.e.from, to = this.e.to;
		let stroke = arrow.stroke;
		let ends = ENDS.find(([, , h, b]) => h === arrow.head && b === arrow.both)?.[0] ?? 'arrow';
		let length = String(Math.min(3, arrow.length));
		const save = () => {
			this.close();
			const [, , head, both] = ENDS.find(([k]) => k === ends)!;
			const next: Arrow = { stroke, head, both, length: Number(length) === Math.min(3, arrow.length) ? arrow.length : Number(length) };
			this.onSave(next, label, from, to);
		};
		const pick = (d: DropdownComponent, value: string, set: (v: string) => void) => {
			for (const n of nodes) d.addOption(n.id, n.label === n.id ? n.id : `${n.label} (${n.id})`);
			d.setValue(value).onChange(set);
		};
		let fromDrop: DropdownComponent | null = null, toDrop: DropdownComponent | null = null;
		new Setting(this.contentEl).setName('From').addDropdown(d => { fromDrop = d; pick(d, from, v => { from = v; }); })
			.addExtraButton(b => b.setIcon('arrow-up-down').setTooltip('Swap from and to').onClick(() => {
				[from, to] = [to, from];
				fromDrop?.setValue(from);
				toDrop?.setValue(to);
			}));
		new Setting(this.contentEl).setName('To').addDropdown(d => { toDrop = d; pick(d, to, v => { to = v; }); });
		new Setting(this.contentEl).setName('Label').setDesc('Shown on the link. Leave empty for none.').addText(t => {
			t.setValue(label).onChange(v => { label = v; });
			onEnter(t.inputEl, save);
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).setName('Line').addDropdown(d => {
			for (const [k, n] of LINES) d.addOption(k, n);
			d.setValue(stroke).onChange(v => { stroke = v as Stroke; });
		});
		new Setting(this.contentEl).setName('Ends').addDropdown(d => {
			for (const [k, n] of ENDS) d.addOption(k, n);
			d.setValue(ends).onChange(v => { ends = v; });
		});
		new Setting(this.contentEl).setName('Minimum length').setDesc('Longer pushes the two nodes further apart.').addDropdown(d => {
			for (const [k, n] of LENGTHS) d.addOption(k, n);
			d.setValue(length).onChange(v => { length = v; });
		});
		const buttons = new Setting(this.contentEl);
		addDeleteButton(buttons, this, 'Really delete the link?', this.onDelete);
		buttons
			.addButton(b => b.setButtonText('Save').setCta().onClick(save))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** A group (subgraph): title, own direction, dissolve, delete with its nodes. */
export class GroupModal extends Modal {
	constructor(
		app: App,
		private g: { title: string; direction: Direction | null; linkedOutside: boolean },
		private onSave: (title: string | null, direction: Direction | null | undefined) => void,
		private onUngroup: () => void,
		private onDelete: () => void,
	) {
		super(app);
	}

	onOpen() {
		const g = this.g;
		this.setTitle(`Edit group "${g.title}"`);
		let title = g.title;
		const dir0 = g.direction ?? '';
		let dir = dir0;
		const save = () => {
			this.close();
			const t = title.trim() && title.trim() !== g.title ? title : null;
			const d = dir !== dir0 ? ((dir || null) as Direction | null) : undefined;
			if (t !== null || d !== undefined) this.onSave(t, d);
		};
		new Setting(this.contentEl).setName('Title').addText(t => {
			t.setValue(title).onChange(v => { title = v; });
			onEnter(t.inputEl, save);
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		new Setting(this.contentEl).setName('Direction')
			.setDesc(g.linkedOutside
				? 'How the group lays out its nodes. Mermaid ignores it while a node in the group links to a node outside it, as one does here.'
				: 'How the group lays out its nodes.')
			.addDropdown(d => {
			d.addOption('', 'As the diagram');
			for (const [k, name] of DIRECTIONS) d.addOption(k, name);
			d.setValue(dir).onChange(v => { dir = v; });
		});
		const buttons = new Setting(this.contentEl);
		addDeleteButton(buttons, this, 'Really delete, with its nodes?', this.onDelete);
		buttons
			.addButton(b => b.setButtonText('Ungroup').setTooltip('Remove the group, keep its nodes').onClick(() => { this.close(); this.onUngroup(); }))
			.addButton(b => b.setButtonText('Save').setCta().onClick(save))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** The diagram's direction. */
export class DirectionModal extends Modal {
	constructor(app: App, private current: Direction, private onSave: (d: Direction) => void) {
		super(app);
	}

	onOpen() {
		this.setTitle('Flowchart direction');
		let dir: Direction = this.current === 'TD' ? 'TB' : this.current;
		new Setting(this.contentEl).setName('Direction').addDropdown(d => {
			for (const [k, name] of DIRECTIONS) d.addOption(k, name);
			d.setValue(dir).onChange(v => { dir = v as Direction; });
		});
		new Setting(this.contentEl)
			.addButton(b => b.setButtonText('Save').setCta().onClick(() => {
				this.close();
				if (dir !== (this.current === 'TD' ? 'TB' : this.current)) this.onSave(dir);
			}))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}
