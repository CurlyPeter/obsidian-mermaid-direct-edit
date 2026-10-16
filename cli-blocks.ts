/**
 * Which diagram a CLI command works on, shared by the commands that take a note or a text:
 * `wardley-read`/`wardley-apply` (`wardley-cli.ts`) and `export`/`export-check` (`export-cli.ts`).
 */
import { App, TFile } from 'obsidian';
import { mermaidBlocks } from './blocks';
import { CliError } from './cli';

export interface CliBlock {
	source: string;
	file?: TFile;
	/** 1-based among the note's blocks the command accepts. */
	block?: number;
}

/** `source=` as given; `\n` stands for a line break when the value has no real one. */
const sourceFlag = (v: string) => (v.includes('\n') ? v : v.replace(/\\n/g, '\n'));

/** The note `path=` names: the exact path, the path without `.md`, or a name resolved like a wikilink. */
export function noteOf(app: App, path: string): TFile {
	const file = app.vault.getFileByPath(path) ?? app.vault.getFileByPath(`${path}.md`)
		?? app.metadataCache.getFirstLinkpathDest(path, '');
	if (!file) throw new CliError('not-found', `No note "${path}".`);
	return file;
}

/**
 * `source=` as given, or block `block=` (1-based) of the note `path=` among its ```mermaid
 * blocks of their own that `accept` keeps; `block=` is required when there are several.
 * `noun` names those blocks in messages ("wardley"), `none` says what the note lacks.
 */
export async function cliBlock(app: App, flags: Record<string, string>, opts: { accept?: (body: string) => boolean; noun: string; none: string }): Promise<CliBlock> {
	if (flags.source !== undefined) {
		if (flags.path !== undefined) throw new CliError('bad-flag', 'Give either path= or source=, not both.');
		return { source: sourceFlag(flags.source) };
	}
	if (!flags.path) throw new CliError('bad-flag', `path=<note> or source=<${opts.noun} text> is required.`);
	const file = noteOf(app, flags.path);
	const blocks = mermaidBlocks(await app.vault.read(file)).filter(b => opts.accept?.(b.body) ?? true);
	if (!blocks.length) throw new CliError('no-block', `${file.path} has no \`\`\`mermaid block ${opts.none}.`);
	let n = 1;
	if (flags.block !== undefined) {
		n = Number(flags.block);
		if (!Number.isInteger(n) || n < 1 || n > blocks.length) throw new CliError('bad-flag', `block=${flags.block}: the note has ${blocks.length} ${opts.noun} block(s).`);
	} else if (blocks.length > 1) {
		throw new CliError('ambiguous-block', `${file.path} has ${blocks.length} ${opts.noun} blocks; choose one with block=1..${blocks.length}.`);
	}
	return { source: blocks[n - 1].body, file, block: n };
}
