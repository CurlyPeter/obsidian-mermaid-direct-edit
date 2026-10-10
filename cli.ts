/**
 * Plugin CLI convention: Obsidian CLI commands (`obsidian <plugin-id>:<action>`,
 * Plugin.registerCliHandler, Obsidian 1.12.2+) with one answer format for every plugin.
 *
 * The same file is shared by the maintainer's plugins that offer CLI commands (no shared
 * package; keep it identical below this header). Scripts call these commands through
 * `obs`, a wrapper of the Obsidian CLI that keeps stdin open and returns real exit codes.
 *
 * Node-free, like the rest of this plugin: it runs on the phone too, where the CLI
 * does not exist and the registration is simply never called.
 *
 * - The answer is ONE compact JSON object whose FIRST key is "ok":
 *     {"ok":true,"data":…}  or  {"ok":false,"error":{"code":"…","message":"…"}}
 *   `obs` maps the literal prefix {"ok":false to exit 1, so key order is part of the
 *   contract. The Obsidian CLI itself always exits 0.
 * - A handler never throws to Obsidian: a thrown error would reach the caller as bare
 *   "Error: …" text. Throw `CliError` for an expected failure with a stable code.
 * - Every plugin also answers `<plugin-id>:info` (version, contract, command list), so
 *   a script can check what the running build offers.
 * - Register in `onload` BEFORE the first await: the CLI queues calls that arrive during
 *   startup and runs them at layout-ready, and only a handler registered by then is found.
 */
import type { CliData, CliFlags, Plugin } from 'obsidian';

/** Version of the envelope above. Bump only on a breaking change. */
export const CLI_CONTRACT = 1;

export class CliError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
		this.name = 'CliError';
	}
}

export interface CliCommandSpec {
	/** Becomes `<plugin-id>:<action>`. Kebab-case verb, optionally verb-noun. */
	action: string;
	description: string;
	flags?: CliFlags;
	run: (flags: CliData) => unknown;
}

/** Runs a handler body and wraps its outcome in the envelope. Never rejects. */
export async function runCliHandler(run: CliCommandSpec['run'], flags: CliData): Promise<string> {
	try {
		const data = await run(flags);
		return JSON.stringify({ ok: true, data: data === undefined ? null : data });
	} catch (e) {
		const code = e instanceof CliError ? e.code : 'internal';
		const message = e instanceof Error ? e.message : String(e);
		return JSON.stringify({ ok: false, error: { code, message } });
	}
}

/** The `info` command every plugin using this file answers. */
export function infoSpec(pluginId: string, version: string, actions: string[]): CliCommandSpec {
	return {
		action: 'info',
		description: 'Plugin version and its CLI commands (JSON)',
		run: () => ({
			plugin: pluginId,
			version,
			contract: CLI_CONTRACT,
			commands: ['info', ...actions].map(a => `${pluginId}:${a}`),
		}),
	};
}

/**
 * Registers `<plugin-id>:info` plus the given commands. Obsidian unregisters them
 * itself when the plugin unloads. A no-op on Obsidian builds without the API.
 */
export function registerCliCommands(plugin: Plugin, specs: CliCommandSpec[]): void {
	if (typeof plugin.registerCliHandler !== 'function') return;
	const id = plugin.manifest.id;
	const all = [infoSpec(id, plugin.manifest.version, specs.map(s => s.action)), ...specs];
	for (const spec of all) {
		plugin.registerCliHandler(`${id}:${spec.action}`, spec.description, spec.flags ?? null,
			(flags: CliData) => runCliHandler(spec.run, flags));
	}
}

/** Reads an enum flag; absent means `fallback`, anything outside `allowed` is a CliError. */
export function enumFlag<T extends string>(flags: CliData, name: string, allowed: readonly T[], fallback: T): T {
	const raw = flags[name];
	if (raw === undefined) return fallback;
	if ((allowed as readonly string[]).includes(raw)) return raw as T;
	throw new CliError('bad-flag', `${name}=${raw}: expected one of ${allowed.join('|')}`);
}
