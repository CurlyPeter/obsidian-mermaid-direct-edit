/**
 * `export` and `export-check`: a drawing as a file for scripts and agents, and whether such a
 * file still matches its note. Contract: `docs/export.md`.
 */
import { App, TFile, requireApiVersion } from 'obsidian';
import { MAX_SOURCE, mermaidBlocks } from './blocks';
import { CliCommandSpec, CliError, enumFlag } from './cli';
import { cliBlock, noteOf } from './cli-blocks';
import { ExportOptions, Exported, TooLargeError } from './export';
import { ExportFormat, MAX_SCALE, MIN_SCALE, checkOutPath, fileChecksum, sha256Hex } from './export-format';

/** Layout width of a CLI export when none is given (px). */
const DEFAULT_WIDTH = 1000;

type Draw = (src: string, format: ExportFormat, opts: ExportOptions) => Promise<Exported>;

/**
 * Refuses when Obsidian (1.13+) holds back Mermaid in this vault: the vault's permission, which the
 * user grants on the first diagram, is kept in local storage. The note view shows its guard then,
 * so the export must not draw either (security review 0.25.0, I-2).
 */
function requireMermaidPermission(app: App) {
	if (!requireApiVersion('1.13.0')) return;
	const appId = (app as unknown as { appId?: string }).appId;
	if (appId && window.localStorage.getItem(`${appId}-mermaid-vault-trust`) !== 'true') {
		throw new CliError('not-permitted', 'Mermaid is not enabled for this vault: open a note with a diagram in Obsidian and allow it once.');
	}
}

/** `out=` checked (CliError when refused). */
function outOf(flags: Record<string, string>) {
	const out = checkOutPath(flags.out ?? '');
	if (typeof out === 'string') throw new CliError('bad-flag', out);
	return out;
}

/** A number flag within [min, max]; absent: `fallback`. */
function numberFlag(flags: Record<string, string>, name: string, min: number, max: number, fallback: number): number {
	if (flags[name] === undefined) return fallback;
	const n = Number(flags[name]);
	if (!Number.isFinite(n) || n < min || n > max) throw new CliError('bad-flag', `${name}=${flags[name]}: expected a number from ${min} to ${max}.`);
	return n;
}

/** Writes `data` to `path`, creating its folder; an existing file is replaced. */
export async function writeExport(app: App, path: string, data: string | Uint8Array) {
	const slash = path.lastIndexOf('/');
	if (slash > 0 && !app.vault.getAbstractFileByPath(path.slice(0, slash))) await app.vault.createFolder(path.slice(0, slash));
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing && !(existing instanceof TFile)) throw new CliError('not-a-file', `${path} is a folder.`);
	if (typeof data === 'string') {
		if (existing) await app.vault.modify(existing as TFile, data);
		else await app.vault.create(path, data);
		return;
	}
	const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	if (existing) await app.vault.modifyBinary(existing as TFile, bytes);
	else await app.vault.createBinary(path, bytes);
}

export function exportCliSpecs(app: App, draw: Draw): CliCommandSpec[] {
	return [{
		action: 'export',
		description: 'Writes a diagram as a standalone PNG or SVG file into the vault (JSON)',
		flags: {
			path: { value: '<note>', description: 'Vault path of the note' },
			block: { value: '<n>', description: 'Which mermaid block of the note (1-based), when it has several' },
			source: { value: '<text>', description: 'The diagram text itself instead of a note (\\n for line breaks)' },
			out: { value: '<file>', description: 'Vault path of the file to write, .png or .svg (replaced when it exists)', required: true },
			scale: { value: '<n>', description: `PNG: pixels per drawing pixel, ${MIN_SCALE} to ${MAX_SCALE} (default 2)` },
			background: { value: 'white|transparent', description: 'Ground of the file (default white)' },
			width: { value: '<px>', description: `Layout width for diagrams that fill their container, e.g. gantt (default ${DEFAULT_WIDTH})` },
		},
		run: async flags => {
			const out = outOf(flags);
			const scale = numberFlag(flags, 'scale', MIN_SCALE, MAX_SCALE, 2);
			const width = numberFlag(flags, 'width', 320, 4000, DEFAULT_WIDTH);
			const white = enumFlag(flags, 'background', ['white', 'transparent'] as const, 'white') === 'white';
			requireMermaidPermission(app);
			const b = await cliBlock(app, flags, { noun: 'mermaid', none: 'of its own' });
			if (b.source.length > MAX_SOURCE) throw new CliError('too-large', `The diagram text is over ${MAX_SOURCE / 1024} KB.`);
			let file: Exported;
			try {
				file = await draw(b.source, out.format, { width, scale, white });
			} catch (e) {
				if (e instanceof TooLargeError) throw new CliError('too-large', e.message);
				throw new CliError('render-failed', `Mermaid cannot draw this diagram: ${e instanceof Error ? e.message : String(e)}`);
			}
			await writeExport(app, out.path, file.data);
			return {
				path: out.path,
				format: file.format,
				width: file.width,
				height: file.height,
				...(file.scale !== undefined ? { scale: file.scale } : {}),
				bytes: typeof file.data === 'string' ? new TextEncoder().encode(file.data).length : file.data.length,
				sha256: file.checksum,
				...(b.file ? { note: b.file.path, block: b.block } : {}),
			};
		},
	}, {
		action: 'export-check',
		description: 'Whether an exported file still matches a diagram in its note: current, stale, missing or no-checksum (JSON)',
		flags: {
			path: { value: '<note>', description: 'Vault path of the note the file was exported from', required: true },
			out: { value: '<file>', description: 'Vault path of the exported .png or .svg', required: true },
		},
		run: async flags => {
			const out = outOf(flags);
			if (!flags.path) throw new CliError('bad-flag', 'path=<note> is required.');
			const note = noteOf(app, flags.path);
			const base = { path: out.path, note: note.path };
			const file = app.vault.getFileByPath(out.path);
			if (!file) return { status: 'missing', ...base };
			const data = out.format === 'svg' ? await app.vault.read(file) : new Uint8Array(await app.vault.readBinary(file));
			const checksum = fileChecksum(out.format, data);
			if (!checksum) return { status: 'no-checksum', ...base };
			const blocks = mermaidBlocks(await app.vault.read(note));
			for (let i = 0; i < blocks.length; i++) {
				if (await sha256Hex(blocks[i].body) === checksum) return { status: 'current', ...base, block: i + 1, sha256: checksum };
			}
			return { status: 'stale', ...base, sha256: checksum };
		},
	}];
}
