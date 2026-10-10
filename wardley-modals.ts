import { App, Modal, Setting } from 'obsidian';
import type { LinkKind, Method } from './wardley-text';

/** Edit an element: rename it, switch inertia and type (components), an extra action, or delete it. */
export interface EditOptions {
	title: string;
	name: string;
	/** Label of the text field and of its button; an annotation edits its text, not a name. */
	field?: { label: string; submit: string };
	/** Current inertia of a component; null where the standard has none (anchors, forces). */
	inertia: boolean | null;
	onInertia?: (on: boolean) => void;
	/** Current sourcing method of a component (null = default); absent where the standard has none. */
	method?: { value: Method | null; onChange: (method: Method | null) => void };
	onRename: (name: string) => void;
	/** Label of the second, confirming click on Delete. */
	deleteConfirm: string;
	onDelete: () => void;
	extra?: { label: string; onClick: () => void };
}

export class EditModal extends Modal {
	constructor(app: App, private o: EditOptions) {
		super(app);
	}

	onOpen() {
		const o = this.o;
		this.setTitle(o.title);
		let value = o.name;
		const submit = () => { this.close(); if (value.trim() && value.trim() !== o.name) o.onRename(value); };
		new Setting(this.contentEl).setName(o.field?.label ?? 'Name').addText(t => {
			t.setValue(o.name).onChange(v => { value = v; });
			t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		if (o.inertia !== null && o.onInertia) {
			new Setting(this.contentEl)
				.setName('Inertia')
				.setDesc('Resistance to change, drawn as a bar on the evolution axis.')
				.addToggle(t => t.setValue(o.inertia!).onChange(on => { this.close(); o.onInertia!(on); }));
		}
		if (o.method) {
			const method = o.method;
			new Setting(this.contentEl)
				.setName('Type')
				.setDesc('How the component is sourced, drawn as a ring around the circle.')
				.addDropdown(d => d
					.addOptions({ default: 'Default', build: 'Build', buy: 'Buy', outsource: 'Outsource', market: 'Market' })
					.setValue(method.value ?? 'default')
					.onChange(v => { this.close(); method.onChange(v === 'default' ? null : v as Method); }));
		}
		if (o.extra) {
			const extra = o.extra;
			new Setting(this.contentEl).addButton(b => b.setButtonText(extra.label).onClick(() => { this.close(); extra.onClick(); }));
		}
		let armed = false;
		new Setting(this.contentEl)
			.addButton(b => b.setButtonText('Delete').setWarning().onClick(() => {
				// Two steps: the first click only asks, the second deletes.
				if (!armed) { armed = true; b.setButtonText(o.deleteConfirm); return; }
				this.close();
				o.onDelete();
			}))
			.addButton(b => b.setButtonText(o.field?.submit ?? 'Rename').setCta().onClick(submit))
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
		let armed = false;
		new Setting(this.contentEl)
			.addButton(b => b.setButtonText('Delete').setWarning().onClick(() => {
				if (!armed) { armed = true; b.setButtonText('Really delete the link?'); return; }
				this.close();
				this.onDelete();
			}))
			.addButton(b => b.setButtonText('Save').setCta().onClick(save))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Asks for one line of text (the name of a new element, the text of a note). */
export class NameModal extends Modal {
	constructor(app: App, private title: string, private field: string, private done: (value: string) => void) {
		super(app);
	}

	onOpen() {
		this.setTitle(this.title);
		let value = '';
		const submit = () => { this.close(); if (value.trim()) this.done(value); };
		new Setting(this.contentEl).setName(this.field).addText(t => {
			t.onChange(v => { value = v; });
			t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.addButton(b => b.setButtonText('Add').setCta().onClick(submit))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}
