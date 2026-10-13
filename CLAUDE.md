# CLAUDE.md - Mermaid Direct Edit

Guide for coding agents and contributors. User documentation: `README.md`; how to
contribute: `CONTRIBUTING.md`; history and decisions: `DEV.md`.

Obsidian plugin (id `mermaid-direct-edit`, formerly `mermaid-pinned`) with two parts:

1. **Rendering:** Obsidian's **native** ` ```mermaid ` code blocks are drawn with a pinned,
   current Mermaid release instead of the one Obsidian bundles, so `wardley-beta` (Wardley
   maps, Mermaid >= 11.14) and other new diagram types work in reading view, live preview and
   PDF export.
2. **Direct editing:** a rendered diagram can be edited with mouse or finger, and every edit
   is written back into the code block as text. Wardley maps (since 0.2.0) and flowcharts
   (since 0.18.0); the goal is more diagram types (see `CONTRIBUTING.md`).

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

## The editor core (shared by every diagram type)

Since 0.18.0 the parts that do not depend on the diagram type live in shared modules, and each
diagram type adds one set of `<type>-*.ts` modules on top. An editor handles only the SVGs tagged
with its kind (`data-mp-kind`), so the editors never see each other's diagrams.

| File | Role | Tested by |
|---|---|---|
| `render.ts` | `wrapRender` with one `RenderHook` per diagram type (which `aria-roledescription`, when it stays untagged, SVG transforms), `SourceRegistry`, `diagramOf`/`diagramIn`, `isElement` | E2E |
| `editor.ts` | `DiagramEditor`: the DOM handlers (registered by `main.ts` on every window, incl. `contextmenu`), one active gesture, the waiting stub, legend, double tap, swallowing the clicks a gesture leaves, dialogs closed on unload, `apply` (edit → `mermaid.parse` → write) and `applyThen` (the same with a notice that has an Undo button). A subclass implements `modelOf`, `press`, `claims`, `cursorAt`, `legendAction`, `stubDrag`, and may add `stubPress` (click, then click links), `hoverAt`, `contextMenu`, `stubWaits` and refuse a diagram (`blockedReason`) | E2E (both suites) |
| `gestures.ts` | `DragGesture` (tap vs drag threshold), `Stub` (with a round handle at its free end) and `NewLinkDrag` (the "+" link, its end under the pointer: onto an element links, into free space creates one, back on its own element waits), `TapPress`, `DeletePress`, `DropHighlight` | E2E |
| `legend.ts`, `modals.ts`, `write.ts`, `blocks.ts`, `geometry.ts` | legend (rows as the diagram's height allows, on the popover layer, closed once an entry is chosen, a 44 px corner on touch), `NameModal` and the two-click Delete, writing into the note, `locateBlock`/`mermaidBlocks`/limits/`EditError`, thresholds and `TapDetector` | vitest (`blocks`, `geometry`), E2E |

`npm run e2e` runs both suites (`scripts/e2e-wardley.py`, `scripts/e2e-flowchart.py`, sharing
`scripts/e2e_obsidian.py`); each drives every gesture with real input through `obs dev:cdp` on a
scratch note and checks the resulting source. Run them after any change to an editor and on
every Mermaid bump. They locate elements from the rendered SVG only, and refuse to send input
to a point outside the scratch note's visible editor (input there lands in another tab). The
flowchart suite holds three settings for its run and restores them: full width on and readable
line length off (its diagram then fits the window), native menus off (a macOS menu is not in the
page). CDP
input reaches only the main window, so the pop-out case dispatches pointer events in the
pop-out's own document instead; a touch double tap is dispatched in the page too (CDP is too
slow for 400 ms).

## Editing Wardley maps

**Modules** (refactored 0.12.0 after a code review, behaviour unchanged except the fixes):

| File | Role | Tested by |
|---|---|---|
| `wardley-text.ts` | every edit as a pure text function on the block source; `editBlocker` (which maps are editable) | vitest, outputs parsed by the real `@mermaid-js/parser`; `*.security.test.ts` |
| `wardley-geometry.ts` | zones and tunables (screen px), projection | vitest |
| `wardley-render.ts` | its `RenderHook`: `editBlocker`, then `placeInertia` (`%% mp-inertia`), `applyClasses` (`%% class` / `%% classDef`), `applyGroups` (`%% group`) in that order; `readDrawing` (nodes by label, links by the nodes their ends touch) shared | vitest on a captured Mermaid SVG (`wardley.fixtures.ts`), E2E |
| `wardley-groups.ts` | a group's boundary as pure geometry: skeleton (spanning tree), distance field, closing (distance transform), marching squares, outer loops, smoothed path | vitest by properties (`wardley-groups.test.ts`) |
| `wardley-map.ts` | `MapModel`: source, plot box, node centres, cached per SVG | E2E |
| `wardley-hit.ts` | `classify()`: what a press means, the one priority order | E2E |
| `wardley-gestures.ts` | one class per gesture (drag, tap, long press), started by the editor | E2E |
| `wardley-legend.ts`, `wardley-modals.ts` | legend items, dialogs | E2E |
| `wardley-editor.ts` | `WardleyEditor extends DiagramEditor`: classify → gesture / dialog → `apply` | E2E |
| `wardley-model.ts` | the map as data: `readModel` (Mermaid's parser AST → model with lines and errors), `applyModel` (target model → in-place edits) | vitest against the real parser (`wardley-model.test.ts`) |
| `wardley-cli.ts` | CLI commands `wardley-read`, `wardley-apply`: block lookup in a note, Mermaid check, write | real `obsidian` call |


Setting "Full-width diagrams without readable line length" (default off): a body class
`mde-full-width`, and `styles.css` sizes every `.mermaid svg` to `width: 100%; height: auto`
in views without Obsidian's `is-readable-line-width` class. CSS only, so toggling the setting or
readable line length needs no redraw; the editor is unaffected because it projects through
`getScreenCTM()` at use time. `@media screen`: print and PDF keep the usual size.

Setting "Edit Wardley maps" (default on, per device in `data.json`). In a rendered
`wardley-beta` map: **drag** an anchor, component or note to move it, **drag a component's
label** to move only the label (`label [dx, dy]`), **drag the tip of an evolve arrow** to
lengthen or shorten it (`evolve Name 0.62`), **drag a link's end onto another node** to
re-link it (`A -> B` becomes `A -> C`, either end, any arrow kind), **click or tap a link's
middle** to open its dialog (label, direction, delete), **click an evolve arrow's shaft** to
delete it (touch: long press, 550 ms), **drag an
inertia bar** along the evolution axis, **press beside a node** (the "+" ring) to start a new link (dropped on free space it asks for a
name and creates a component there, linked from the first, since 0.18.0),
**double-click / double-tap** a node to open its dialog (rename everywhere in the block,
switch a component's inertia on or off, set its type (the sourcing decorator
`(build|buy|outsource|market)` or none, via `getMethod`/`setMethod`; not offered for pipeline
components, which have none in wardley-beta), or delete it with its links and evolve arrow after a
confirming second click). Name, inertia and type are written together with Save, as one edit
(since 0.18.0; before, switching inertia or type wrote at once and closed the dialog, dropping a
name typed just before); the rename goes last, so the other edits find the old name. A **legend**
(shown only when the pointer reaches the very bottom-left or bottom-right corner, a 32 px
zone about the size of Obsidian's edit button, in that corner; stays open while the pointer
is on it; mobile: a tap in a corner) adds a component, anchor, note, annotation, accelerator or
deaccelerator (name/text asked, placed on a free spot by `freeSpot`), or, armed, an evolve
arrow, inertia or a pipeline component on the next component pressed.
**Accelerators/deaccelerators** (`accelerator Name [v, e]`) drag as a whole and have a dialog
(rename, delete). **Pipelines** (`pipeline Parent { component Child [evo] }`): drag the box
or the parent square to move the whole pipeline (parent position plus every child's
evolution), drag a child along its evolution, its label like a component's; the parent's
dialog has "Remove pipeline"; deleting the last child removes the block.
**Annotations** (`annotation N,[v, e] "text"`, listed in the box `annotations [v, e]`): drag the
numbered circle or the box; double-click a circle or a line in the box for its dialog (text,
delete).

- `wrapRender` tags every editable SVG with `data-mp-src`, a key into a map of the exact
  source Obsidian passed to `render()` (400 entries, shared by both editors), and `data-mp-kind`;
  a Wardley map drawn before 0.18.0 has no kind and counts as Wardley (it asks for a redraw). An edit locates that source in the note; it must
  occur exactly once, otherwise the edit is refused (embeds, duplicated blocks).
- All text logic is pure and unit-tested in `wardley-text.ts` (`getPosition`,
  `setPosition`, `rename`, `formatName` following Mermaid's `NAME_WITH_SPACES` terminal:
  umlauts, dots etc. force quotes). Every result is validated with `mermaid.parse()`
  before it is written.
- **No write may close its own block (security review 0.18.0):** `writeBlock` refuses text holding
  a line CommonMark reads as the block's closing fence (`fenceBreak` in `blocks.ts`: up to three
  spaces, the same fence character, at least as long), for both editors and for Undo; an
  Ungroup had moved an indented fence to column 0. The `wardley-apply` write in `wardley-cli.ts`
  goes through it too (security review 0.19.0: a link kind with line breaks had passed the model
  check and Mermaid's parse). Any new write path must call it.
- **Write path differs by mode:** Live Preview/source dispatches to CodeMirror directly
  (undoable with Cmd+Z); reading view writes the file with `vault.process`, because the
  editor buffer is not saved from there. **Never `Editor.replaceRange`:** it scrolls the
  selection into view, and the note jumped to its top after every edit. Before the change
  the cursor is parked on the line below the block (outside it, so Live Preview keeps the
  widget), so Cmd+Z returns to the map; the scroll position is held through the redraw.
- Positions are projected from the declared coordinates and the two axis lines
  (`g.wardley-axes > line`), not from the drawn glyph: anchors, market nodes and pipeline
  parents have no plain circle.
- Events are taken in the **capture phase** (else Live Preview opens the source) on the
  `document` of **every window**: the main one and each pop-out, wired on load and on
  `window-open`, since a pop-out's events never reach the main document. Never
  `instanceof Element` on an event target: in a pop-out it is false (another window's
  realm); use `isElement` from `render.ts`. Touch: `touch-action` is ignored inside SVG, so `touchstart` on a node is
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
- **Classes (0.19.0): `%% class <targets> <class>`**, e.g. `%% class Kettle highlight` or
  `%% class Kettle -> Power highlight` (a link: its two ends, either order, always `->`), several
  targets comma-separated. Mermaid's own `class` statement, commented out until wardley-beta
  supports it; no `mp-` prefix on purpose, deleting `%% ` is meant to be the migration (upstream
  proposal: `DEV.md` → "Proposal: classes for wardley-beta"). Text side in `wardley-text.ts`
  (`classLine`, linear like every parser here; `setClass`, `setClasses`, `getClasses`):
  `rename`, `deleteElement`, `deletePipeline`, `unlink` and `relink` keep the lines in step
  through `editClassTargets` (a re-linked link keeps its class). Drawing: `applyClasses` adds
  `mde-class mde-class-<name>` to the node's `<g class="wardley-node …">` or the link's line,
  found by label and by the nodes a line's ends touch; `styles.css` draws `highlight` in
  `--color-accent` (outline 2.5 px and bold label; a link only in colour); a
  `%% classDef <class> …` adds inline style from a whitelist (`STYLE_VALUE`: colours and plain
  numbers, never `url()`; Mermaid had CSS injection through `classDef`). The label takes the
  classDef's `color`, else its `stroke`. A link's flow head follows its line through
  `fill: context-stroke` on the shared markers. `wardley-read` reports `classes` and
  `classDefs`, `wardley-apply` takes `classes`; the dialogs have a Highlight toggle.
  **Bounded (security review 0.19.0):** class lines are comments, outside Mermaid's size limit,
  and duplicate links are each drawn, so `applyClasses` draws at most `MAX_CLASSES` (8) per
  element, names are at most 40 characters (`CLASS_NAME`), and it inserts at most 256 KB per
  drawing (else Mermaid's drawing is kept); link ends go through a grid, only when a class names
  a link. Keep every new per-target step a lookup, never a scan.
- **Groups (0.20.0): `%% group <name> <members>`**, e.g. `%% group "Human + AI" Staff, Cup of
  Tea` (name first, quoted when it holds blanks; several lines with one name make one group; a
  link belongs to a group when both its ends do). The proposed `group` statement, commented out;
  proposal and research: `DEV.md` → "Proposal: groups for wardley-beta". Text side in
  `wardley-text.ts` (`groupLine` on the shared `scanTargets`, `groupMarkers`, `groupsOf`,
  `editGroupMembers`, kept in step by `rename`, `deleteElement`, `deletePipeline`). Drawing:
  `applyGroups` inserts one `<g class="mde-groups">` of number-only paths before the pipelines,
  links and nodes (`pointer-events="none"`, no note text in the drawing), `styles.css` makes them
  dotted in `--color-accent`. Geometry in `wardley-groups.ts`: the outline is the exact swept area
  united with its closing, so keep that union if you touch it (the closing alone shrinks every
  outline by half a grid step). Bounded: 20 groups, 100 members, `GROUP_BUDGET` evaluations, at
  most `MAX_CELLS` grid cells per group (larger areas get a coarser grid, never no boundary), 256 KB
  of paths; contour tracing uses integer edge keys and typed arrays (string keys dominated a crafted
  render, review 0.20.0). `wardley-read` reports `groups`.
- **`wardley-read` blanks comment lines before Mermaid's parser** (`withoutComments`, line numbers
  kept, multi-line `accDescr` untouched): the parser is super-linear in them. The plugin's own
  comments are read from the source. It lists at most `MAX_ERRORS` (200) errors plus a count.
- **Notes** are plain `text` in `g.wardley-notes`, starting at the declared position; a drag
  rewrites `note "text" [v, e]`, matched by its exact text (must occur once).
- **Annotations** are matched by their number (must occur once). Mermaid draws them last
  (`g.wardley-annotations`: a `g.wardley-annotation` per circle, then `g.wardley-annotations-box`
  with a `rect` and one `text` per line, `N. text`), so they lie on top and are classified
  first. The box is clamped into the map by the renderer, so a drag writes the drawn corner
  plus the offset, not the declared one. A new annotation gets the highest number plus one and,
  when the map has no box, `annotations [0.97, 0.03]` (without a box Mermaid shows no text);
  deleting the last one removes the box. Texts cannot hold `"` (the STRING terminal would end).
- **Label offsets exist only for components and pipeline components** (grammar measured:
  Accelerator/Deaccelerator `name, x, y`; Anchor `name, visibility, evolution`; a note is
  its text). Names of accelerators are drawn 30 px right of / below the arrow's anchor point.
- **A pipeline parent is not drawn at its declared position** but as a small square above
  the middle of its box; `centerOf` uses the square, and node drops apply deltas to the
  declared position. Inside the box the box wins over loose link zones and the "+" ring; a
  link end there needs a hit within 3 px.
- **Gesture priority** (`classify()` in `wardley-hit.ts`, shared by press, touch start and
  hover): before it, the waiting stub's free end, the legend and an armed legend action. Then
  **elements under the pointer win over zones**: annotation circle or box, note,
  accelerator/deaccelerator, inertia bar, node or label; then evolve tip, evolve shaft, link end, link middle; the "+" ring; a pipeline
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
  `applyClasses` follows the same rule: it inserts class names and whitelisted inline styles into
  existing tags and keeps Mermaid's drawing when the string's node and link tags do not match the
  parse. Its node pattern must not match the container `<g class="wardley-nodes">` (it did once,
  and the count check still agreed); `wardley-render.test.ts` runs on a captured real SVG.
- **The model (`wardley-read`/`wardley-apply`) is a public contract**, `docs/wardley-model.md`,
  versioned by `SCHEMA`. A field changing meaning or disappearing bumps it; new optional fields
  do not. Reading takes the AST of `@mermaid-js/parser` (pinned to the exact version Mermaid
  depends on, so the bundle holds one copy; bump both together) and only adds what the AST
  lacks: lines, the 0-1 normalisation, `mp-inertia`, and the checks Mermaid does not make.
  Applying never re-emits: every change goes through the `wardley-text.ts` edits, and a
  statement type the model does not know shows up in `unsupported` instead of being dropped.
- **The default inertia position is computed from Mermaid's renderer constants** (`MERMAID` and
  `defaultInertia` in `wardley-model.ts`: width 900, padding 48, node radius 6, the bar offsets).
  Re-check them against `wardleyDiagram-*.mjs` on every Mermaid bump; a live render must give
  the same `inertiaAt` as `wardley-read` (DEV.md 0.15.0).
- **Mermaid's numbers need a decimal point** (`WARDLEY_NUMBER` is `[0-9]+\.[0-9]+`): `[50, 70]`
  does not parse, a 0-100 map is written `[50.0, 70.0]`. Mermaid reads each value on its own
  (at most 1 is decimal, above 1 percent).
- Unit tests that run Mermaid's flowchart parser need a DOM for its sanitizer: they start with
  `// @vitest-environment happy-dom` (dev dependency only). happy-dom's sanitizer drops text
  before a `<br/>`, so such labels are compared as one token (`test-mermaid.ts`).
- Depends on Mermaid's wardley SVG classes (`wardley-node`, `wardley-node-label`,
  `wardley-link`, `wardley-trend`, `wardley-axes`, `wardley-annotation`, `wardley-annotations-box`). Re-check them on every Mermaid bump (DEV.md).

## Editing flowcharts

Setting "Edit flowcharts" (default on, per device). In a rendered `flowchart` / `graph` (the UI
says "link" for an edge, Mermaid's own word):

- **Node:** double-click / double-tap for its dialog (label, shape, color, group incl. "New
  group…", delete with its links); drag onto a group to move it in, outside every group to move
  it out (a hint at the pointer says which, the group being left is outlined; onto another node:
  nothing, a notice points to the ring).
- **"+" ring** beside a node (hovering a node shows small "+" marks where it works): drag onto
  another node to link them, into free space to create a node linked from the first
  (`A --> NewNode[Label]`, inside A's group when A is in one; the new node flashes once after the
  redraw); a click leaves the stub waiting with a round handle, then drag the handle or click the
  target node. Dropped back on its own node the stub waits.
- **Link:** a click on its middle, its label or near an end opens its dialog (from, to with a
  swap button, label, line, ends, minimum length, delete); dragging an end re-links it.
- **Group:** double-click its title or its border for its dialog (title, direction with a note
  when Mermaid will ignore it, ungroup, delete with its nodes).
- **Legend** (bottom corners, as for Wardley maps; 44 px corner zone on touch): add a node of a
  shape, put the next node clicked into a new group, the diagram's direction.
- **Right-click** anywhere on the diagram: the same actions as an Obsidian menu (a node's, a
  link's, a group's, or the legend's on empty space).
- **Structural edits** (delete, re-link, group moves, ungroup, links and nodes added) confirm with
  a notice that has an **Undo** button: reading view and phones have no Cmd+Z. Undo writes the old
  source back if the block is still the new one.
- **Touch:** nothing in a flowchart is dragged except a waiting stub's handle, and no touch blocks
  scrolling: a swipe that starts on the diagram scrolls, it never edits. Everything is reachable
  with taps (double tap for dialogs, the link dialog's From/To for re-linking, the node dialog's
  Group). Wardley maps keep their immediate touch drags (positions are their core gesture).

**Modules:**

| File | Role | Tested by |
|---|---|---|
| `flowchart-scan.ts` | `scan()`: the source as statements, nodes (id, shape, label, `@{…}`, `:::class`) and edges (arrow, label, id) with offsets; subgraphs and their membership; Mermaid's edge ids predicted | vitest: agrees with Mermaid's own parser on the test diagrams, real-world shapes and ~50 edge cases (`flowchart-scan.test.ts`) |
| `flowchart-text.ts` | every edit as a pure text function: node label/shape/color, edges (look, label, reverse, relink, add, delete), nodes (add, add linked, delete), groups (move into/out, add, title, direction, ungroup, delete), direction; `flowchartBlocker` | vitest: every edit on every node/edge/group of the test diagrams (re-links: ~1000), each result read by Mermaid's parser and compared (`flowchart-text.test.ts`); `*.security.test.ts` |
| `flowchart-meaning.ts` | the run-time guard: what a flowchart means (labels, shapes, groups, links, `linkStyle` targets, named group ids); `checked()` refuses an edit whose result changes anything but what it intends | through every edit test |
| `flowchart-map.ts` | `FlowModel`: which drawn element is which node, edge and group; refuses the diagram when drawing and scan disagree; edge path sampling for hit tests | E2E |
| `flowchart-hit.ts` | `classifyFlow()`: the one priority order | E2E |
| `flowchart-gestures.ts` | node drag (into a group), edge-end drag (re-link) | E2E |
| `flowchart-modals.ts`, `flowchart-editor.ts` | dialogs; `FlowchartEditor extends DiagramEditor` and the render hook | E2E |

- **A flowchart has no positions.** Mermaid (dagre or ELK) lays it out on every render, so
  nothing positional is stored and no plugin comments are written: dragging connects, re-links or
  moves a node into a group.
- **Identity from the drawing, places from the scanner, checked against each other.** Mermaid's
  flowchart parser (JISON, not `@mermaid-js/parser`) reports no source positions, so
  `flowchart-scan.ts` finds them. The drawing names everything: a node's group id is
  `<svg id>-flowchart-<node id>-<counter>`, an edge's path has `data-id` = the edge's id
  (`L_<from>_<to>_<n>`, n = 0 for the first such pair, else their count + 1; or a user id from
  `e1@-->`), a group's cluster id is `<svg id>-<subgraph id>`, an empty subgraph is drawn as a
  node named by its id alone. `FlowModel` requires the drawn nodes and edges to equal the scan's
  exactly; otherwise the diagram is not edited (one notice per drawing, the press is left to
  Obsidian), never guessed. Example: a label containing `direction LR` makes Mermaid's lexer read
  the whole line as a direction statement.
- **Lexer facts the scanner follows (measured on 12.1):** the lexer takes the longest token, so
  `A&B` is one node id and only `A & B` (blank after `&`) is a group; no blank between an id and
  its shape (`A [x]` is an error); a `;` inside `[…]` is label text; `---oB` is a circle-ended
  link to `B`; `-- text -->` is closed by the first token that looks like an arrow end (`go-->`
  ends at `o-->`); trailing `%%` comments are errors; a `style X` statement creates node X, `class`
  does not; a node belongs to the first subgraph, in closing order, whose own statements mention
  it; a subgraph without brackets and with a blank in its text gets the id `subGraph<N>`, N
  counting subgraphs in the order they close.
- **Every edit is checked at run time (`checked`, code review 0.18.0).** The meaning of the new
  source must equal the old one changed exactly as the edit intends; otherwise the edit is
  refused with "This edit would also change …". It turns a gap in the scanner's ordering rules
  (which definition of a node wins, which group claims it, how `linkStyle` counts) into a
  refusal instead of a silent change to parts nobody touched, and it found one gap on its first
  run (a quoted ellipse label).
- **Edits change as little as possible.** A label, an arrow or a name is replaced in place. Only
  when an edit splits a chain (`A --> B --> C`) or an `&` group does it rewrite that one statement:
  same edge order, each node's definition with its first mention, and a bare mention kept for a
  node that would otherwise vanish or leave its group. A user edge id stays with its edge.
- **`linkStyle` counts edges in source order.** Deleting edges renumbers it (a statement left
  with none is removed); new edges go after every other edge (after the subgraph block holding
  the last one), except a node created from a node in a group, which goes into that group and
  shifts later numbers; moving a node out of a group moves statements with edges behind all
  others. Every one of these keeps each `linkStyle` on the same edge (tested).
- **Labels:** bare when the text is safe (letters, digits, blanks, `.,:!?'+*#&%$=~^_-`) and was
  bare, else quoted; `"` becomes `#quot;`; a markdown label (`"\`…\`"`) stays markdown. An inline
  edge label stays inline while it holds none of `-=.|"` or brackets, else it becomes `|label|`.
- **Node colours** are `style <id> fill:…,stroke:…,color:…` with a dark text colour, so the label
  stays readable in dark themes; other properties of that `style` stay.
- **New ids** come from the label (`Check stock` → `CheckStock`, umlauts folded, unique, not a
  keyword), so the source stays readable for people and agents.
- **Hit testing:** an edge is grabbed within 6 screen px of its path (sampled every 4 SVG units),
  its ends within min(24 px, a third of it), its middle between; the "+" ring is a 14 px band
  outside a node's box, but only inside the SVG (a node at the diagram's edge has no ring on that
  side); a group's border within 5 px. Zones double on touch. Elements under the pointer (edge
  label, node, group title) win over zones, then edges, the ring, a group's border.
- **Relinking inside a group:** rewritten in place when that keeps every node in its group;
  otherwise the edge moves behind all others at the top level (`linkStyle` follows), since a
  mention inside a group's block pulls a node into that group.
- **Text Mermaid reads as a direction:** a label or title containing `direction` + TB/BT/LR/RL/TD
  is refused (the lexer reads the whole line as a direction statement, quotes or not).
- **Moving statements keeps the winning definitions:** Mermaid uses a node's last definition;
  moved text keeps only definitions that win, so a move cannot relabel another node.
- **Inserted statements** go right after their anchor statement, not after the rest of its line
  (`A --> B; subgraph S` would take them into S); a new `direction` gets a line of its own.
- **Edge metadata** (`e1@{ animate: true }`, after the edge `e1`) is a statement of its own, not a
  node.
- **Not editable:** over 64 KB or a line over 1000 characters, more than 500 links (Mermaid's own
  `maxEdges`), a source the scanner cannot read, a drawing that disagrees with the scan; plus the
  general rules (callout/list, embeds).
- **Scans are cached** by source text (`scanCached`, 16 entries; a `Flow` is never changed after
  `scan`), so a dialog reading every node and each edit's guard scan a text once.
- **Linear on crafted text (security review 0.18.0):** the next `}%%` is looked up once, link ids
  come from forward-only lookups on the cursor, an inline label's closer skips runs of blanks and
  dots in one step, `&` groups are counted before they multiply. Add a timing case to
  `flowchart-text.security.test.ts` for any new lookup.

## Build and check

```bash
npm test               # vitest: text edits (checked by the real parsers), geometry
npm run e2e            # real-input regression of every gesture in the running Obsidian (both editors)
npm run build          # tsc + esbuild production; postbuild reloads this plugin via obs
obs mermaid-direct-edit:status   # {pinnedVersion, state, obsidianMermaidLoaded, obsidianLoadedFirst, rendering, error}
obs mermaid-direct-edit:info
obs mermaid-direct-edit:wardley-read path="<note>"         # the map as data (docs/wardley-model.md)
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
   rename once in a wardley map and a flowchart (DEV.md → Verification). If the wardley SVG
   classes changed, `wardley-editor.ts` stops finding nodes silently: check that first. For
   flowcharts, `flowchart-scan.test.ts` against the new parser comes first (lexer rules and edge
   ids), then the SVG naming in `flowchart-map.ts` (a mismatch shows as "not editable here").

## Rules

- **Node-free**: it runs on the phone. No `fs`, `path`, `electron`.
- **Never patch Obsidian's files.** The accessor is the whole mechanism.
- `cli.ts` is a shared helper (one JSON answer format for plugin CLI commands), kept
  identical below its header to the maintainer's other plugins.
