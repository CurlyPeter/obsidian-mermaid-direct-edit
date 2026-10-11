import { App, MarkdownView } from 'obsidian';
import { fenceBreak, locateBlock } from './blocks';

/** The Markdown view whose content shows `el`. */
export function viewOf(app: App, el: Element): MarkdownView | null {
	let found: MarkdownView | null = null;
	app.workspace.iterateAllLeaves(leaf => {
		if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) found = leaf.view;
	});
	return found;
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
