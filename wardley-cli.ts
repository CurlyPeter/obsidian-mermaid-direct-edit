/**
 * `wardley-read` and `wardley-apply`: a Wardley map in a note as data, for scripts and agents.
 * The model and its rules live in `wardley-model.ts`; this file finds the block in a note,
 * validates with the running Mermaid and writes. Contract: `docs/wardley-model.md`.
 */
import { App, TFile } from 'obsidian';
import type { Mermaid } from 'mermaid';
import { CliCommandSpec, CliError } from './cli';
import { ParseFn, SCHEMA, applyModel, readModel } from './wardley-model';
import { fenceBreak, locateBlock, mermaidBlocks } from './blocks';
import { isWardley } from './wardley-text';

/** Mermaid's own parser, loaded on first use (it is part of the bundled Mermaid). */
const parser: ParseFn = async (type, text) => (await import('@mermaid-js/parser')).parse(type, text);

interface Block {
	source: string;
	file?: TFile;
	/** 1-based among the note's wardley blocks. */
	block?: number;
}

/** `source=` as given; `\n` stands for a line break when the value has no real one. */
const sourceFlag = (v: string) => (v.includes('\n') ? v : v.replace(/\\n/g, '\n'));

async function blockOf(app: App, flags: Record<string, string>): Promise<Block> {
	if (flags.source !== undefined) {
		if (flags.path !== undefined) throw new CliError('bad-flag', 'Give either path= or source=, not both.');
		return { source: sourceFlag(flags.source) };
	}
	if (!flags.path) throw new CliError('bad-flag', 'path=<note> or source=<wardley-beta text> is required.');
	const file = app.vault.getFileByPath(flags.path) ?? app.vault.getFileByPath(`${flags.path}.md`)
		?? app.metadataCache.getFirstLinkpathDest(flags.path, '');
	if (!file) throw new CliError('not-found', `No note "${flags.path}".`);
	const blocks = mermaidBlocks(await app.vault.read(file)).filter(b => isWardley(b.body));
	if (!blocks.length) throw new CliError('no-block', `${file.path} has no \`\`\`mermaid block with a wardley-beta map of its own.`);
	let n = 1;
	if (flags.block !== undefined) {
		n = Number(flags.block);
		if (!Number.isInteger(n) || n < 1 || n > blocks.length) throw new CliError('bad-flag', `block=${flags.block}: the note has ${blocks.length} wardley block(s).`);
	} else if (blocks.length > 1) {
		throw new CliError('ambiguous-block', `${file.path} has ${blocks.length} wardley blocks; choose one with block=1..${blocks.length}.`);
	}
	return { source: blocks[n - 1].body, file, block: n };
}

/** Whether the running Mermaid accepts `src`; its message when not. */
async function mermaidError(mermaid: Mermaid | undefined, src: string): Promise<string | null> {
	if (!mermaid) return null;
	try {
		await mermaid.parse(src);
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

export function wardleyCliSpecs(app: App, mermaid: () => Mermaid | undefined): CliCommandSpec[] {
	return [{
		action: 'wardley-read',
		description: 'A wardley-beta map as data: elements, links, evolve arrows, notes, forces, each with its line (JSON)',
		flags: {
			path: { value: '<note>', description: 'Vault path of the note' },
			block: { value: '<n>', description: 'Which wardley block of the note (1-based), when it has several' },
			source: { value: '<text>', description: 'The wardley-beta text itself instead of a note (\\n for line breaks)' },
		},
		run: async flags => {
			const b = await blockOf(app, flags);
			const model = await readModel(b.source, parser);
			const err = await mermaidError(mermaid(), b.source);
			if (err && !model.errors.length) model.errors.push({ line: null, message: `Mermaid: ${err}` });
			return b.file ? { path: b.file.path, block: b.block, ...model } : model;
		},
	}, {
		action: 'wardley-apply',
		description: 'Brings a wardley-beta map in line with a model by in-place edits; reports changes and conflicts (JSON)',
		flags: {
			path: { value: '<note>', description: 'Vault path of the note (written unless dry-run)' },
			block: { value: '<n>', description: 'Which wardley block of the note (1-based), when it has several' },
			source: { value: '<text>', description: 'The wardley-beta text itself; never written, the result is returned' },
			model: { value: '<json>', description: 'Target model, the wardley-read shape', required: true },
			'dry-run': { description: 'Report what would change, write nothing' },
			tolerance: { value: '<n>', description: 'Position difference that counts as a move (default 0.01)' },
			'allow-delete': { description: 'Remove what the model does not have (default: report only)' },
		},
		run: async flags => {
			let target: unknown;
			try {
				target = JSON.parse(flags.model ?? '');
			} catch {
				throw new CliError('bad-flag', 'model= must be the target model as JSON.');
			}
			const tolerance = flags.tolerance === undefined ? 0.01 : Number(flags.tolerance);
			if (!Number.isFinite(tolerance) || tolerance < 0) throw new CliError('bad-flag', `tolerance=${flags.tolerance}: expected a number >= 0.`);
			const b = await blockOf(app, flags);
			const r = await applyModel(b.source, target, parser, { tolerance, allowDelete: flags['allow-delete'] !== undefined });
			const changed = r.source !== b.source;
			if (changed) {
				const err = await mermaidError(mermaid(), r.source);
				if (err) throw new CliError('invalid-result', `Mermaid refuses the edited map, nothing was written: ${err}`);
			}
			let written = false;
			if (changed && b.file && flags['dry-run'] === undefined) {
				let refused: string | null = null;
				await app.vault.process(b.file, text => {
					const at = locateBlock(text, b.source);
					if (typeof at === 'string') { refused = at; return text; }
					// No write may close its own block (security review 0.19.0: a crafted link kind did).
					const broken = fenceBreak(text, at, r.source);
					if (broken) { refused = broken; return text; }
					return text.slice(0, at) + r.source + text.slice(at + b.source.length);
				});
				if (refused) throw new CliError((refused as string).includes('changed in the meantime') ? 'stale' : 'not-editable', refused);
				written = true;
			}
			return {
				schema: SCHEMA,
				...(b.file ? { path: b.file.path, block: b.block } : {}),
				inSync: r.changes.length === 0 && r.conflicts.length === 0,
				written,
				changes: r.changes,
				conflicts: r.conflicts,
				source: r.source,
			};
		},
	}];
}
