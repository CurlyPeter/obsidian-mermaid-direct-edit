import { App, MarkdownView, TFile } from 'obsidian';
import { blockAt, fenceBreak, locateBlock, mermaidBlocks } from './blocks';
import type { SourceRegistry } from './render';

/**
 * The note each open zoom (`zoom.ts`) draws a block of, by the zoom's root element: a zoomed
 * diagram lies outside every view, so its edits are written into the note it came from, while
 * that tab still shows it (review 0.24.0, I-1; the same guard as Undo's).
 */
export const zoomViews = new WeakMap<Element, { view: MarkdownView; file: TFile }>();

/** The Markdown view whose content shows `el`, or whose block the zoom around `el` shows. */
export function viewOf(app: App, el: Element): MarkdownView | null {
	const zoom = el.closest('.mde-zoom');
	if (zoom) {
		const origin = zoomViews.get(zoom);
		return origin && origin.view.file === origin.file ? origin.view : null;
	}
	let found: MarkdownView | null = null;
	app.workspace.iterateAllLeaves(leaf => {
		if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) found = leaf.view;
	});
	return found;
}

/** The note and block a drawing shows: block `index` of `count` mermaid blocks. */
export interface Origin {
	view: MarkdownView;
	file: TFile;
	index: number;
	count: number;
}

/**
 * The block `box` (a drawing's `.mermaid`, in a note or in the zoom) shows and its text now, or
 * null when it is not one of a note's own mermaid blocks (an embed, a canvas, a callout). In Live
 * Preview the drawing's place in the editor says which block it is, even when the note changed
 * since it was drawn (Live Preview does not always redraw at once); elsewhere the drawn text is
 * looked up, the n-th of identical ones. Used by the zoom and the export.
 */
export function originOf(app: App, registry: SourceRegistry, box: HTMLElement, drawn: string | undefined): { origin: Origin; src: string } | null {
	if (box.closest('.markdown-embed')) return null;
	const view = viewOf(app, box);
	if (!view?.file) return null;
	const blocks = mermaidBlocks(view.getViewData());
	let index = -1;
	const widget = box.closest('.cm-embed-block');
	const cm = (view.editor as unknown as { cm?: { contentDOM: Element; posAtDOM(node: Node, offset?: number): number } }).cm;
	if (widget && cm?.contentDOM.contains(widget)) {
		try { index = blockAt(blocks, cm.posAtDOM(widget)); } catch { /* not in the editor's document */ }
	}
	if (index < 0 && drawn !== undefined) {
		const hits = blocks.flatMap((b, i) => (b.body === drawn ? [i] : []));
		const same = Array.from(view.containerEl.querySelectorAll('.mermaid')).filter(m => {
			const s = m.querySelector(':scope > svg');
			return s && registry.zoomSourceOf(s) === drawn;
		});
		if (hits.length) index = hits[Math.min(Math.max(0, same.indexOf(box)), hits.length - 1)];
	}
	if (index < 0) return null;
	return { origin: { view, file: view.file, index, count: blocks.length }, src: blocks[index].body };
}

/**
 * Replaces the block `src` (it must occur exactly once) with `next` in the note shown by
 * `view`. Returns null when written, else why not.
 *
 * - **Reading view** writes the file (`vault.process`): the editor buffer is not saved from
 *   there. Obsidian has no undo in reading view.
 * - **Live Preview / source** dispatches to CodeMirror, so Cmd+Z undoes it. Never
 *   `Editor.replaceRange`: it scrolls the selection into view, and the note jumped to its top
 *   after every edit. The cursor is parked on the line below the block first (outside it, or
 *   Live Preview would open the source), so undo, which restores that selection and scrolls to
 *   it, also stays at the map; the scroll position is held through the redraw.
 */
export async function writeBlock(app: App, view: MarkdownView, src: string, next: string): Promise<string | null> {
	if (view.getMode() === 'preview') {
		let refused: string | null = null;
		await app.vault.process(view.file!, text => {
			const at = locateBlock(text, src);
			if (typeof at === 'string') { refused = at; return text; }
			const broken = fenceBreak(text, at, next);
			if (broken) { refused = broken; return text; }
			return text.slice(0, at) + next + text.slice(at + src.length);
		});
		return refused;
	}
	const editor = view.editor;
	const text = editor.getValue();
	const at = locateBlock(text, src);
	if (typeof at === 'string') return at;
	const broken = fenceBreak(text, at, next);
	if (broken) return broken;
	const cm = (editor as unknown as { cm?: { dispatch: (tr: object) => void; scrollDOM?: HTMLElement } }).cm;
	if (!cm) {
		editor.replaceRange(next, editor.offsetToPos(at), editor.offsetToPos(at + src.length));
		return null;
	}
	const scroller = cm.scrollDOM;
	const top = scroller?.scrollTop;
	const fenceEnd = text.indexOf('\n', at + src.length + 1);
	if (fenceEnd >= 0) cm.dispatch({ selection: { anchor: fenceEnd + 1 } });
	cm.dispatch({ changes: { from: at, to: at + src.length, insert: next }, userEvent: 'input.wardley' });
	if (scroller && top !== undefined) {
		const hold = () => { if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top; };
		hold();
		window.requestAnimationFrame(() => { hold(); window.setTimeout(hold, 150); });
	}
	return null;
}
