import { App, Modal, Setting } from 'obsidian';

/** Asks for one line of text (the name of a new element, the text of a note). */
export class NameModal extends Modal {
	constructor(app: App, private title: string, private field: string, private done: (value: string) => void, private initial = '') {
		super(app);
	}

	onOpen() {
		this.setTitle(this.title);
		let value = this.initial;
		const submit = () => { this.close(); if (value.trim()) this.done(value); };
		new Setting(this.contentEl).setName(this.field).addText(t => {
			t.setValue(value).onChange(v => { value = v; });
			t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		new Setting(this.contentEl)
			.addButton(b => b.setButtonText('Add').setCta().onClick(submit))
			.addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * The Delete button every edit dialog has: the first click only relabels it to `confirm`, the
 * second closes the dialog and deletes.
 */
export function addDeleteButton(setting: Setting, modal: Modal, confirm: string, onDelete: () => void) {
	let armed = false;
	setting.addButton(b => b.setButtonText('Delete').setWarning().onClick(() => {
		if (!armed) { armed = true; b.setButtonText(confirm); return; }
		modal.close();
		onDelete();
	}));
}
