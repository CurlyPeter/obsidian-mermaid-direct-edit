/**
 * Sharing and exporting a drawing from the note: the share button beside "Zoom in" (also in the
 * zoom) and the export dialog, which the menu's "Export…" opens as well. See CLAUDE.md → "Export".
 *
 * - **Share button:** on a phone the system's share sheet with the drawing in the share format
 *   (setting, PNG by default); where there is none (Obsidian's desktop app has no Web Share), the
 *   dialog.
 * - **Dialog:** format, scale, background; Copy, Share (where available), Save. Save writes PNG
 *   and SVG next to the note, named after it and the diagram's number (`savedName`).
 * - **User activation:** Copy and Share must run within the click (iOS is strict about it). The
 *   dialog prepares the file for the chosen options as soon as they change, Copy hands the
 *   clipboard a promise, and a share the system refused for lack of a fresh click is offered again
 *   in the dialog.
 */
import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import { Exported, ExportOptions, mimeOf } from './export';
import { writeExport } from './export-cli';
import { ExportFormat, savedName } from './export-format';
import { SourceRegistry } from './render';
import { Origin, originOf } from './write';

export type Draw = (src: string, format: ExportFormat, opts: ExportOptions, doc: Document) => Promise<Exported>;

/** What a drawing on screen is: its block text, the note block it shows (if any), its layout width. */
interface Target {
	src: string;
	origin: Origin | null;
	width: number;
	doc: Document;
}

/** Scale of PNGs from the dialog unless changed. */
const DEFAULT_SCALE = 2;

const bytesOf = (e: Exported) => (typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data);
const blobOf = (e: Exported) => new Blob([bytesOf(e) as BlobPart], { type: mimeOf(e.format) });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A file the system share sheet takes, or null where there is none (desktop app). */
function shareable(doc: Document, file: File): boolean {
	const nav = (doc.defaultView ?? window).navigator;
	return typeof nav.share === 'function' && !!nav.canShare?.({ files: [file] });
}

export class ExportUi {
	private modal: ExportModal | null = null;

	constructor(private app: App, private registry: SourceRegistry, private draw: Draw, private shareFormat: () => ExportFormat) {}

	/** The share button of the drawing in `box`. */
	async share(box: HTMLElement) {
		const t = this.targetOf(box);
		if (!t) return;
		if (!Platform.isMobile) return this.open(t);
		const format = this.shareFormat();
		const probe = new File([''], `x.${format}`, { type: mimeOf(format) });
		if (!shareable(t.doc, probe)) return this.open(t);
		let file: File;
		try {
			file = this.fileOf(t, await this.draw(t.src, format, { width: t.width, scale: DEFAULT_SCALE, white: true }, t.doc));
		} catch (e) {
			return void new Notice(`Mermaid: could not export the diagram: ${message(e)}`);
		}
		try {
			await t.doc.defaultView!.navigator.share({ files: [file] });
		} catch (e) {
			// Cancelled by the user: nothing to do. Refused (the drawing took longer than the click
			// counts as fresh): the dialog, where the next tap on Share has one.
			if ((e as DOMException)?.name !== 'AbortError') this.open(t);
		}
	}

	/** The export dialog for the drawing in `box` (the menu's "Export…"). */
	openDialog(box: HTMLElement) {
		const t = this.targetOf(box);
		if (t) this.open(t);
	}

	/** Closes an open dialog (unload). */
	destroy() {
		this.modal?.close();
	}

	private open(t: Target) {
		this.modal?.close();
		this.modal = new ExportModal(this.app, t, this.draw, this.shareFormat(), f => this.fileOf(t, f), () => { this.modal = null; });
		this.modal.open();
	}

	/** The file name of an export of `t`: the note's name and the diagram's number, else "Diagram". */
	private fileOf(t: Target, e: Exported): File {
		const name = t.origin ? savedName(t.origin.file.basename, t.origin.index + 1) : 'Diagram';
		return new File([bytesOf(e) as BlobPart], `${name}.${e.format}`, { type: mimeOf(e.format) });
	}

	private targetOf(box: HTMLElement): Target | null {
		const svg = box.querySelector(':scope > svg');
		const drawn = svg ? this.registry.zoomSourceOf(svg) : undefined;
		const found = originOf(this.app, this.registry, box, drawn);
		const src = found?.src ?? drawn;
		if (src === undefined) {
			new Notice('Mermaid: this diagram was drawn before the plugin was loaded and is redrawn now, please try again.');
			this.app.workspace.trigger('post-processor-change');
			return null;
		}
		return { src, origin: found?.origin ?? null, width: box.clientWidth || 800, doc: box.ownerDocument };
	}
}

class ExportModal extends Modal {
	private format: ExportFormat;
	private scale = DEFAULT_SCALE;
	private white = true;
	/** Prepared exports by options, so Copy and Share have their file while the click still counts. */
	private ready = new Map<string, Promise<Exported>>();
	private scaleSetting: Setting | null = null;

	constructor(app: App, private t: Target, private draw: Draw, format: ExportFormat, private fileOf: (e: Exported) => File, private closed: () => void) {
		super(app);
		this.format = format;
	}

	onOpen() {
		this.setTitle('Export diagram');
		const { contentEl } = this;
		new Setting(contentEl).setName('Format').addDropdown(d => d
			.addOptions({ png: 'PNG', svg: 'SVG' })
			.setValue(this.format)
			.onChange(v => { this.format = v as ExportFormat; this.update(); }));
		this.scaleSetting = new Setting(contentEl).setName('Scale').setDesc('Pixels per drawing pixel.').addDropdown(d => d
			.addOptions({ 1: '1x', 2: '2x', 3: '3x' })
			.setValue(String(this.scale))
			.onChange(v => { this.scale = Number(v); this.update(); }));
		new Setting(contentEl).setName('White background').setDesc('Off: transparent.').addToggle(t => t
			.setValue(this.white)
			.onChange(v => { this.white = v; this.update(); }));
		const buttons = new Setting(contentEl);
		buttons.addButton(b => b.setButtonText('Copy').onClick(() => this.copy()));
		const probe = new File([''], 'x.png', { type: 'image/png' });
		if (shareable(this.t.doc, probe)) buttons.addButton(b => b.setButtonText('Share').onClick(() => void this.share()));
		if (this.t.origin) {
			const o = this.t.origin;
			buttons.addButton(b => b.setButtonText('Save PNG and SVG').setCta()
				.setTooltip(`Next to the note: ${savedName(o.file.basename, o.index + 1)}.png and .svg`)
				.onClick(() => void this.save()));
		}
		this.update();
	}

	onClose() {
		this.contentEl.empty();
		this.closed();
	}

	private options(): ExportOptions {
		return { width: this.t.width, scale: this.scale, white: this.white };
	}

	/** The export for the current options, started once and kept. */
	private prepared(format = this.format): Promise<Exported> {
		const o = this.options();
		const key = `${format}|${o.scale}|${o.white}`;
		let p = this.ready.get(key);
		if (!p) {
			p = this.draw(this.t.src, format, o, this.t.doc);
			p.catch(() => this.ready.delete(key));  // a failure is not kept: the next click tries again
			this.ready.set(key, p);
		}
		return p;
	}

	private update() {
		this.scaleSetting?.settingEl.toggle(this.format === 'png');
		void this.prepared().catch(() => { /* reported when used */ });
	}

	private copy() {
		const win = this.t.doc.defaultView ?? window;
		const format = this.format;
		const blob = this.prepared(format).then(blobOf);
		// The clipboard gets a promise: the write starts within the click, the drawing may follow.
		const items: Record<string, Promise<Blob>> = { [mimeOf(format)]: blob };
		if (format === 'svg') items['text/plain'] = blob.then(b => new Blob([b], { type: 'text/plain' }));
		win.navigator.clipboard.write([new win.ClipboardItem(items)])
			.then(() => new Notice(`Mermaid: diagram copied as ${format.toUpperCase()}.`))
			.catch(async e => {
				// Where SVG cannot go to the clipboard as an image: its text.
				if (format === 'svg') {
					try {
						await win.navigator.clipboard.writeText((await this.prepared('svg')).data as string);
						return void new Notice('Mermaid: diagram copied as SVG text.');
					} catch { /* reported below */ }
				}
				new Notice(`Mermaid: could not copy the diagram: ${message(e)}`);
			});
	}

	private async share() {
		try {
			const file = this.fileOf(await this.prepared());
			await this.t.doc.defaultView!.navigator.share({ files: [file] });
			this.close();
		} catch (e) {
			const name = (e as DOMException)?.name;
			if (name === 'AbortError') return;
			new Notice(name === 'NotAllowedError' ? 'Mermaid: the diagram is ready now, tap Share again.' : `Mermaid: could not share the diagram: ${message(e)}`);
		}
	}

	private async save() {
		const o = this.t.origin!;
		const dir = o.file.parent && o.file.parent.path !== '/' ? `${o.file.parent.path}/` : '';
		const base = `${dir}${savedName(o.file.basename, o.index + 1)}`;
		try {
			const [png, svg] = await Promise.all([this.prepared('png'), this.prepared('svg')]);
			await writeExport(this.app, `${base}.png`, png.data);
			await writeExport(this.app, `${base}.svg`, svg.data);
			new Notice(`Mermaid: saved ${base}.png and .svg.`);
			this.close();
		} catch (e) {
			new Notice(`Mermaid: could not save the diagram: ${message(e)}`);
		}
	}
}
