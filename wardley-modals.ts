import { App, Modal, Setting } from 'obsidian';
import { addDeleteButton } from './modals';
import type { LinkKind, Method } from './wardley-text';

/** What changed in the element dialog; absent fields stay as they are. */
export interface EditChanges {
	name?: string;
	inertia?: boolean;
	method?: Method | null;
}

/** Edit an element: its name (or an annotation's text), inertia and type (components), an extra action, delete. */
export interface EditOptions {
	title: string;
	name: string;
	/** Label of the text field; an annotation edits its text, not a name. */
	field?: string;
	/** Current inertia of a component; null where the standard has none (anchors, forces). */
	inertia: boolean | null;
	/** Current sourcing method of a component (null = default); undefined where the standard has none. */
	method?: Method | null;
	/** Everything that changed, written as one edit (one undo step). */
	onSave: (changes: EditChanges) => void;
	/** Label of the second, confirming click on Delete. */
	deleteConfirm: string;
	onDelete: () => void;
	/** A structural action that acts at once (Remove pipeline), like Ungroup in a flowchart. */
	extra?: { label: string; onClick: () => void };
}

/**
 * The element dialog. Like the flowchart dialogs, every field is collected and Save writes them
 * together (0.18.0): before, switching Inertia or Type wrote at once and closed the dialog, which
 * dropped a name typed just before.
 */
export class EditModal extends Modal {
	constructor(app: App, private o: EditOptions) {
		super(app);
	}

	onOpen() {
		const o = this.o;
		this.setTitle(o.title);
		let value = o.name;
		let inertia = o.inertia;
		let method = o.method;
		const save = () => {
			this.close();
			const c: EditChanges = {};
			if (value.trim() && value.trim() !== o.name) c.name = value;
			if (inertia !== null && inertia !== o.inertia) c.inertia = inertia;
			if (method !== undefined && method !== o.method) c.method = method;
			if (Object.keys(c).length) o.onSave(c);
		};
		new Setting(this.contentEl).setName(o.field ?? 'Name').addText(t => {
			t.setValue(o.name).onChange(v => { value = v; });
			t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		if (o.inertia !== null) {
			new Setting(this.contentEl)
				.setName('Inertia')
				.setDesc('Resistance to change, drawn as a bar on the evolution axis.')
				.addToggle(t => t.setValue(o.inertia!).onChange(on => { inertia = on; }));
		}
		if (o.method !== undefined) {
			new Setting(this.contentEl)
				.setName('Type')
				.setDesc('How the component is sourced, drawn as a ring around the circle.')
				.addDropdown(d => d
					.addOptions({ default: 'Default', build: 'Build', buy: 'Buy', outsource: 'Outsource', market: 'Market' })
					.setValue(o.method ?? 'default')
					.onChange(v => { method = v === 'default' ? null : v as Method; }));
		}
		if (o.extra) {
			const extra = o.extra;
			new Setting(this.contentEl).addButton(b => b.setButtonText(extra.label).onClick(() => { this.close(); extra.onClick(); }));
		}
		const buttons = new Setting(this.contentEl);
		addDeleteButton(buttons, this, o.deleteConfirm, o.onDelete);
		buttons
			.addButton(b => b.setButtonText('Save').setCta().onClick(save))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** A link: its label (empty = none), its kind (line, dashed, arrow either way, both), delete. */
export class LinkModal extends Modal {
	constructor(
		app: App,
		private link: { from: string; to: string; kind: LinkKind; label: string },
		private onSave: (kind: LinkKind, label: string) => void,
		private onDelete: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { from, to } = this.link;
		this.setTitle(`Link "${from}" – "${to}"`);
		let label = this.link.label;
		let kind = this.link.kind;
		const save = () => { this.close(); if (label.trim() !== this.link.label || kind !== this.link.kind) this.onSave(kind, label); };
		new Setting(this.contentEl).setName('Label').setDesc('Shown along the line. Leave empty for none.').addText(t => {
			t.setValue(label).onChange(v => { label = v; });
			t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).setName('Direction').addDropdown(d => d
			.addOptions({
				line: 'None (line)',
				dashed: 'None (dashed line)',
				forward: `${from} → ${to}`,
				backward: `${to} → ${from}`,
				both: `${from} ↔ ${to}`,
			})
			.setValue(kind)
			.onChange(v => { kind = v as LinkKind; }));
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
