# CLAUDE.md - Mermaid Direct Edit

Guide for coding agents and contributors. User documentation: `README.md`; how to
contribute: `CONTRIBUTING.md`; history and decisions: `DEV.md`.

Obsidian plugin (id `mermaid-direct-edit`, formerly `mermaid-pinned`) with two parts:

1. **Rendering:** Obsidian's **native** ` ```mermaid ` code blocks are drawn with a pinned,
   current Mermaid release instead of the one Obsidian bundles, so `wardley-beta` (Wardley
   maps, Mermaid >= 11.14) and other new diagram types work in reading view, live preview and
   PDF export.
2. **Direct editing:** a rendered diagram can be edited with mouse or finger, and every edit
   is written back into the code block as text. Version 1 covers Wardley maps; the goal is
   more diagram types (see `CONTRIBUTING.md`).

Runs on desktop and mobile.

## How it works

Obsidian (measured in `app.js` of 1.14.4) loads `/lib/mermaid.min.js` lazily on the first
diagram. The script ends with `globalThis.mermaid = …`; Obsidian then calls
`mermaid.initialize(config)` and renders every block through the global `mermaid.render()`.

The plugin turns `window.mermaid` into an accessor:

- **setter** keeps Obsidian's own instance (`obsidianMermaid`), so it is never lost;
- **getter** hands out the pinned instance, required lazily on first access (startup does
  not evaluate Mermaid);
- the pinned instance's `initialize` merges `CLASSIC` (`look: classic`, `layout: dagre`,
  `theme: default`) over whatever Obsidian passes, so 12.x keeps the 11.x look;
- **Obsidian loaded first** (plugin enabled or reloaded later): the plugin initializes the
  pinned instance with `OBSIDIAN_CONFIG`, a verbatim copy of Obsidian's call, and redraws;
- **unload** deletes the accessor and re-initializes Obsidian's instance, without a redraw
  (Obsidian's 11.x cannot draw wardley-beta; see DEV.md 0.10.2), and `WardleyEditor.destroy()`
  removes every trace of the editor;
- **load failure** of the pinned bundle: the getter returns Obsidian's instance, state
  `failed`, error logged.

Redraw = `workspace.trigger('post-processor-change')`, the same event Obsidian fires when
the vault's Mermaid permission is toggled. That permission (since 1.13) is untouched: an
unpermitted vault keeps showing Obsidian's guard instead of the diagram.

## Editing Wardley maps

**Modules** (refactored 0.12.0 after a code review, behaviour unchanged except the fixes):

| File | Role | Tested by |
|---|---|---|
| `wardley-text.ts` | every edit as a pure text function on the block source; `editBlocker` (which maps are editable), `locateBlock` (where a block sits in the note) | vitest, outputs parsed by the real `@mermaid-js/parser`; `*.security.test.ts` |
| `wardley-geometry.ts` | zones and tunables (screen px), projection, `TapDetector` | vitest |
| `wardley-render.ts` | `wrapRender` (tags editable SVGs, applies `%% mp-inertia`), `SourceRegistry` | E2E |
| `wardley-map.ts` | `MapModel`: source, plot box, node centres, cached per SVG | E2E |
| `wardley-hit.ts` | `classify()`: what a press means, the one priority order | E2E |
| `wardley-gestures.ts` | one class per gesture (drag, tap, long press), started by the editor | E2E |
| `wardley-legend.ts`, `wardley-modals.ts`, `wardley-write.ts` | legend, dialogs, writing into the note | E2E |
| `wardley-editor.ts` | wiring: DOM events → classify → gesture / dialog → `apply` | E2E |

`npm run e2e` (`scripts/e2e-wardley.py`) drives every gesture with real input through
`obs dev:cdp` on a scratch note and checks the resulting source; run it after any change to
the editor and on every Mermaid bump. It locates elements from the rendered SVG only.


Setting "Edit Wardley maps" (default on, per device in `data.json`). In a rendered
`wardley-beta` map: **drag** an anchor, component or note to move it, **drag a component's
label** to move only the label (`label [dx, dy]`), **drag the tip of an evolve arrow** to
lengthen or shorten it (`evolve Name 0.62`), **drag a link's end onto another node** to
re-link it (`A -> B` becomes `A -> C`, either end, any arrow kind), **click or tap a link's
middle** to open its dialog (label, direction, delete), **click an evolve arrow's shaft** to
delete it (touch: long press, 550 ms), **drag an
inertia bar** along the evolution axis, **press beside a node** (the "+" ring) to start a new link,
**double-click / double-tap** a node to open its dialog (rename everywhere in the block,
switch a component's inertia on or off, or delete it with its links and evolve arrow after a
confirming second click). A **legend**
(shown only when the pointer reaches the very bottom-left or bottom-right corner, a 32 px
zone about the size of Obsidian's edit button, in that corner; stays open while the pointer
is on it; mobile: a tap in a corner) adds a component, anchor, note, accelerator or
deaccelerator (name/text asked, placed on a free spot by `freeSpot`), or, armed, an evolve
arrow, inertia or a pipeline component on the next component pressed.
**Accelerators/deaccelerators** (`accelerator Name [v, e]`) drag as a whole and have a dialog
(rename, delete). **Pipelines** (`pipeline Parent { component Child [evo] }`): drag the box
or the parent square to move the whole pipeline (parent position plus every child's
evolution), drag a child along its evolution, its label like a component's; the parent's
dialog has "Remove pipeline"; deleting the last child removes the block.

- `wrapRender` tags every wardley SVG with `data-mp-src`, a key into a map of the exact
  source Obsidian passed to `render()`. An edit locates that source in the note; it must
  occur exactly once, otherwise the edit is refused (embeds, duplicated blocks).
- All text logic is pure and unit-tested in `wardley-text.ts` (`getPosition`,
  `setPosition`, `rename`, `formatName` following Mermaid's `NAME_WITH_SPACES` terminal:
  umlauts, dots etc. force quotes). Every result is validated with `mermaid.parse()`
  before it is written.
- **Write path differs by mode:** Live Preview/source dispatches to CodeMirror directly
  (undoable with Cmd+Z); reading view writes the file with `vault.process`, because the
  editor buffer is not saved from there. **Never `Editor.replaceRange`:** it scrolls the
  selection into view, and the note jumped to its top after every edit. Before the change
  the cursor is parked on the line below the block (outside it, so Live Preview keeps the
  widget), so Cmd+Z returns to the map; the scroll position is held through the redraw.
- Positions are projected from the declared coordinates and the two axis lines
  (`g.wardley-axes > line`), not from the drawn glyph: anchors, market nodes and pipeline
  parents have no plain circle.
- Events are taken in the **capture phase** on `document` (else Live Preview opens the
  source). Touch: `touch-action` is ignored inside SVG, so `touchstart` on a node is
  `preventDefault`ed (non-passive) to stop the scroll that would cancel the pointer stream.
  Double tap is detected by the plugin (400 ms); on desktop the system `dblclick` also opens
  the rename, which is what slow scripted clicks hit.
- **Label offsets** (Mermaid 12.1 grammar): `component Name [v, e] label [dx, dy]`, integer
  map pixels relative to the circle centre, before any decorator; default when absent is
  `[8, -8]` (`[18, -18]` with build/buy/outsource). Decimals do not parse (OWM writes them).
  **Anchors have no label offset** in the grammar: their label is the anchor itself, so
  dragging it moves the anchor.
- **Evolve arrows** (`line.wardley-trend`) are 1 px wide, so the tip is grabbed by
  distance (`TIP_RADIUS`, 10 screen px) instead of by element; the owner is the node whose
  centre is the line's start. Mermaid stops the line `nodeRadius + 2` short of the target,
  which the drag adds back. Mouse hover over a tip shows `ew-resize`.
- **Link ends** are grabbed on the line 7-28 screen px from the node (`LINK_GRAB`); the
  node's centre stays the move handle. Mermaid ends link lines at the circle's rim, not the
  centre, so endpoints are matched to nodes within `END_TOLERANCE` (10 map px). Dropped
  within `DROP_RADIUS` (16 screen px) of a node centre, highlighted while dragging.
  `relink()` refuses a self-link, an existing link and an ambiguous (duplicated) link.
- **New links**: wardley-beta has no link with one end, so a click in the ring around a node
  (`PLUS_RING`, 9-22 screen px) draws a provisional stub (`line.mp-new-link`, SVG only, never
  written). Dragging its free end onto another node writes `from -> to` (`addLink`, after the
  last link); a press in the ring can also drag straight to the target. Escape, a press
  elsewhere, a redraw or unload drop the stub.
- **Link dialog** (middle of a link, between the two end bands): label (`; label`, omitted
  when empty; an inline flow label `+'x'>` is read and folded into that form) and direction:
  line `->`, dashed `-.->`, `+>` towards the second name, `+<` towards the first, `+<>` both
  (marker-end/-start measured on 12.1). Delete with a confirming second click.
- **Cursors** are set inline on the svg during hover (custom SVG data-URI cursors: red ✕ for
  delete, "+" for add; `crosshair` on a link end, `ew-resize` on an evolve tip); nodes and
  labels get theirs from `styles.css`. Every mermaid svg shows the arrow, not the I-beam.
- **Inertia** is the standard's term for the blocker: `(inertia)` after the position, after a
  build/buy/outsource decorator, never on anchors (all three measured against the parser);
  drawn as `line.wardley-inertia` inside the node's group, i.e. on the evolve arrow's shaft.
- **Inertia position is a plugin extension, not wardley-beta.** The grammar has inertia only as
  a flag and the renderer draws the bar at a fixed offset, so a dragged position is stored as
  a Mermaid comment `%% mp-inertia <name> <evolution>` right after the declaration and applied
  by `placeInertia()` on the SVG string inside `wrapRender`. Other renderers (mmdc for the
  print, static sites) ignore the comment and show the default position until the export applies it
  too. `rename`, `setInertia(off)` and `deleteElement` keep the comment consistent.
- **Notes** are plain `text` in `g.wardley-notes`, starting at the declared position; a drag
  rewrites `note "text" [v, e]`, matched by its exact text (must occur once).
- **Label offsets exist only for components and pipeline components** (grammar measured:
  Accelerator/Deaccelerator `name, x, y`; Anchor `name, visibility, evolution`; a note is
  its text). Names of accelerators are drawn 30 px right of / below the arrow's anchor point.
- **A pipeline parent is not drawn at its declared position** but as a small square above
  the middle of its box; `centerOf` uses the square, and node drops apply deltas to the
  declared position. Inside the box the box wins over loose link zones and the "+" ring; a
  link end there needs a hit within 3 px.
- **Gesture priority** (`classify()` in `wardley-hit.ts`, shared by press, touch start and
  hover): before it, the waiting stub's free end, the legend and an armed legend action. Then
  **elements under the pointer win over zones**: note, accelerator/deaccelerator, inertia bar,
  node or label; then evolve tip, evolve shaft, link end, link middle; the "+" ring; a pipeline
  box last. (Before 0.12.0 zones came first, so a click on a component lying on another's
  evolve arrow deleted that arrow.)
- **One gesture at a time**: a press while one is active (a second finger) is ignored; clicks
  after a gesture are swallowed only inside that map.
- **Not every map is editable** (`editBlocker`, then the SVG stays untagged and renders as
  usual): the 0-100 scale (the editor writes 0-1), a line over `MAX_LINE` (1000) or a source
  over `MAX_SOURCE` (64 KB), a multi-line `accDescr {…}` (free text the line parsers would read
  as declarations). Maps embedded from another note (`.markdown-embed`) are skipped, and a
  write goes only into the body of a fenced ```` ```mermaid ```` block of its own: a map in a
  callout or list is refused with a message, an identical text elsewhere is never touched.
- **Parsers on note text must stay linear.** Notes come from sync, shared vaults and pastes; a regex
  with overlapping quantifiers (`(.+?)([ \t]+)…`, `[^\]]+?[ \t]*`) froze Obsidian on a crafted
  line (security review 0.13.0). Use index scans and `trimTail`, and add a timing case to
  `wardley-text.security.test.ts` for any new per-line parser.
- **`placeInertia` never re-serializes the SVG**: it reads with `DOMParser` and only swaps the
  numbers of `<line class="wardley-inertia" x1=… y1=… x2=…>`, so the sanitized output stays as
  DOMPurify left it. A new attribute order after a Mermaid bump makes it keep Mermaid's bar.
- Depends on Mermaid's wardley SVG classes (`wardley-node`, `wardley-node-label`,
  `wardley-link`, `wardley-trend`, `wardley-axes`). Re-check them on every Mermaid bump (DEV.md).

## Build and check

```bash
npm test               # vitest: text edits (checked by the real parser), geometry
npm run e2e            # real-input regression of every gesture in the running Obsidian
npm run build          # tsc + esbuild production; postbuild reloads this plugin via obs
obs mermaid-direct-edit:status   # {pinnedVersion, state, obsidianMermaidLoaded, obsidianLoadedFirst, rendering, error}
obs mermaid-direct-edit:info
```

`obs` is a thin wrapper around the Obsidian CLI (Obsidian 1.12+, `obsidian <command>`) that
keeps stdin open so asynchronous answers arrive, and returns real exit codes. Without it, use
`obsidian` from an interactive terminal; the E2E script reads the command from `OBSIDIAN_CLI`.

`main.js` is **tracked** (it is the shipped artefact, ~5.3 MB with Mermaid inside), so a
`git pull` installs a working build; releases attach it as well. The
bundled version is read from `node_modules/mermaid/package.json` at build time
(`__MERMAID_VERSION__`), so the version shown is the one actually inside `main.js`.

## Bumping Mermaid

1. `npm install --save-exact mermaid@<version>`, then read that release's notes for
   changed defaults (layout, look, theme) and adjust `CLASSIC`.
2. If Obsidian itself was updated, re-check its `initialize` call in the running asar
   (`~/Library/Application Support/obsidian/obsidian-<ver>.asar`, `app.js`, search
   `/lib/mermaid.min.js`) and update `OBSIDIAN_CONFIG`.
3. `npm test && npm run build && npm run e2e`, then check several mermaid notes and drag /
   rename once in a wardley map (DEV.md → Verification). If the wardley SVG classes
   changed, `wardley-editor.ts` stops finding nodes silently: check that first.

## Rules

- **Node-free**: it runs on the phone. No `fs`, `path`, `electron`.
- **Never patch Obsidian's files.** The accessor is the whole mechanism.
- `cli.ts` is a shared helper (one JSON answer format for plugin CLI commands), kept
  identical below its header to the maintainer's other plugins.
