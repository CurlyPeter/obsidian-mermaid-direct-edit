# Contributing

Thank you for helping. Small pull requests are as welcome as big ones: a fixed typo, a clearer notice, a new gesture, or a first step towards editing another diagram type.

## Set up in five steps

1. **Use a test vault**, not your real one. Create an empty vault in Obsidian and enable Mermaid if asked.
2. **Fork** this repository on GitHub, then clone your fork into the test vault's plugin folder:
   ```bash
   cd "<test vault>/.obsidian/plugins"
   git clone https://github.com/<you>/obsidian-mermaid-direct-edit.git mermaid-direct-edit
   cd mermaid-direct-edit
   ```
3. **Install and build** (Node.js 20 or newer):
   ```bash
   npm install
   npm run build      # type check + bundle into main.js
   ```
4. **Enable** "Mermaid Direct Edit" under Settings → Community plugins. After each build, reload it (toggle it off and on, or run "Reload app without saving" from the command palette).
5. **Check** your change:
   ```bash
   npm test           # unit tests, run on every pull request
   ```
   For changes to gestures, try them in a note with a `wardley-beta` or `flowchart` block (the README has an example).

## Open a pull request

1. Create a branch: `git checkout -b my-change`.
2. Commit and push it to your fork: `git push -u origin my-change`.
3. On GitHub, click **Compare & pull request** and target `main`.
4. Say in a few lines **what** changes for the user and **why**. For anything visible, add a screenshot or a short GIF.

GitHub runs the type check and the tests on every pull request. Don't worry if something is not perfect: we will sort it out together in the review. For a bigger idea, opening an issue first saves you work.

## Where things are

`CLAUDE.md` is the guide to the code, written for human and AI contributors alike: how the Mermaid swap works, the module map of the Wardley editor, the order in which a press is interpreted, and the grammar facts the editor relies on. `DEV.md` holds the decisions and the history.

In short:

| File | Role |
|---|---|
| `main.ts` | loads the pinned Mermaid in place of Obsidian's, settings, event wiring |
| `editor.ts`, `gestures.ts`, `render.ts`, `legend.ts`, `modals.ts`, `write.ts` | the editor core every diagram type shares: events, gestures, legend, dialogs, writing into the note |
| `actions.ts`, `zoom.ts` | the buttons of every drawing (Zoom in, the menu) and the zoom, in which every editor works unchanged |
| `wardley-text.ts`, `flowchart-text.ts` | every edit as a pure function on the code block's text (unit tested against Mermaid's parser) |
| `flowchart-scan.ts` | reads a flowchart's code into nodes and edges with their positions in the text |
| `wardley-hit.ts`, `flowchart-hit.ts` | what a press at a point means |
| `wardley-gestures.ts`, `flowchart-gestures.ts` | one class per gesture (drag, tap, long press) |
| `wardley-editor.ts`, `flowchart-editor.ts` | what each diagram type does with a press, its legend and its dialogs |
| `wardley-model.ts`, `wardley-cli.ts` | the map as JSON for scripts and agents (`wardley-read`, `wardley-apply`, [docs/wardley-model.md](docs/wardley-model.md)) |

## A few rules

- **Edits are text functions with tests.** A new edit goes into `wardley-text.ts`, `flowchart-text.ts` (or a new `<diagram>-text.ts`) as a pure function, with a test whose output is parsed by Mermaid's real parser (see `wardley-text.test.ts`, `flowchart-text.test.ts`).
- **A new diagram type** is a `DiagramEditor` subclass plus its `RenderHook` (see `flowchart-editor.ts`); the core handles events, gestures, the legend and writing.
- **No regex that can backtrack on note text.** Notes can come from anywhere. Parse lines with index scans; `wardley-text.security.test.ts` shows how to add a timing test.
- **No Node or Electron APIs** (`fs`, `path`, `electron`): the plugin runs on phones too.
- **Never write outside the diagram's own code block.** Use `locateBlock` and the existing write path.
- Style: TypeScript strict, tabs, short comments that explain *why*.

## Ideas to pick up

- **Other diagram types.** Mermaid has no stored positions for most diagrams (sequence, class, state), so direct editing there means text edits, as for flowcharts: rename from the label, add or delete an edge, change an arrow type, reorder messages. The flowchart editor (`flowchart-*.ts`) is the pattern to copy.
- A keyboard way to nudge a selected Wardley element.
- Better touch handling on phones (pinch zoom over a map, larger hit zones).

## For maintainers: releasing

1. Bump `version` in `manifest.json` and `package.json`, add the version to `versions.json`, and add a changelog entry to `DEV.md`.
2. `npm test && npm run build`, commit, and tag the commit with the bare version (`0.15.0`, no `v`).
3. `gh release create 0.15.0 main.js manifest.json styles.css --title 0.15.0 --notes "…"`.

## Code of conduct

Be kind and assume good intent. Critique code, not people.
