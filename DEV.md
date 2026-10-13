# DEV.md - Mermaid Direct Edit

## Decisions (2026-10-10)

- **Own plugin, not a module in one of the maintainer's existing plugins.** Those are
  desktop-only (would never reach the phone) or thin clients by design, where a 5 MB
  renderer would be 30x their size. An own plugin also makes "off" simply
  "disable the plugin", so no setting is needed.
- **Mermaid 12.x with the classic config, not the last 11.x.** Same major as `mmdc` 12,
  which pre-renders the same diagrams for print, so one version everywhere. 12.0 made ELK
  the default layout (`layout: "elk"` in 12.1's default config; `look` and `theme`
  still default to `classic`/`default`). `CLASSIC` pins all three.
- **Bundle via npm + esbuild, not the UMD `mermaid.min.js`.** The UMD file writes to the
  global `__esbuild_esm_mermaid_nm`, which Obsidian already owns, and then hands back
  Obsidian's OLD instance. The ESM import touches no globals. Everything sits in
  `main.js`: whether Obsidian Sync carries extra files in a plugin folder is unverified,
  `main.js` it certainly carries.
- **Accessor on `window.mermaid` instead of wrapping `loadMermaid()`.** It catches
  Obsidian's lazy load whenever it happens, needs no forced load at startup, and lets
  Obsidian's own `initialize` call configure the pinned instance.

## Verification (2026-10-10, macOS desktop, Obsidian 1.14.4, Mermaid 12.1.0)

- **Cold start** (`app:reload`, test note open): `obsidianLoadedFirst: false`, Obsidian's
  later load landed in the setter, `window.mermaid` is the pinned instance. Effective
  config: `layout dagre`, `look classic`, `theme default`, `securityLevel strict`,
  `fontFamily var(--font-mermaid)`, `flowchart.useMaxWidth false`, i.e. Obsidian's config
  plus `CLASSIC`.
- **Hot enable** (Obsidian loaded first): renders after the redraw, same config.
- `Test/Mermaid Test Wardley Map Test.md` in reading view: `flowchart-v2`, `sequence`,
  `wardley`, no parse errors; in live preview the `sequence` and `wardley` widgets rendered
  (the flowchart block held the cursor, so it stayed source), light and dark theme checked by screenshot (the Wardley map
  draws its own black background in dark mode, readable).
- **All 12 mermaid blocks in the vault** (7 notes) render with 12.1.0. Control: the same
  blocks parsed with Obsidian's 11.13 all pass except `wardley-beta` (fails there).
- **Disable** restores Obsidian's instance (accessor gone, `wardley-beta` fails again).
  Since 0.10.2 open notes are no longer redrawn on unload (see changelog). Side-by-side screenshot of a note with state diagrams: state
  diagrams practically identical, 12.x boxes slightly wider.
- **Fallback**: a simulated load failure (stubbed `loadPinned`) leaves Obsidian's 11.13
  rendering, state `failed`, error logged.
- **Load time**: `enablePlugin` about 110 ms on the macOS desktop, including evaluating Mermaid
  (hot-enable path). Phone not measured yet.

**Not yet verified at the time:** iPhone; PDF export.

## Wardley editing (0.2.0, 2026-10-10)

Ordered by priority: (1) move, (2) rename, (3) re-link deferred until 1 and 2
have been used. Decisions:

- **Edit the text, not the SVG.** The SVG is only the input device; every gesture becomes
  a text edit on the block, validated by `mermaid.parse()`, so the note stays the single
  source and an agent sees exactly what the user did.
- **Editor write in Live Preview, file write in reading view.** Measured: in reading view
  `editor.replaceRange` changed the buffer (`Kettle [0.53, 0.55]`) but nothing was saved and
  the view did not redraw, even after `view.save()`.
- **Centre from the source, not the glyph.** First version measured the circle; anchors
  have none (only a label), so they could not be dragged.
- **Native `dblclick` in addition to own double-tap detection.** Scripted CDP clicks take
  ~0.5 s each, too slow for 400 ms; real desktop double clicks fire `dblclick` anyway.

Verification (macOS desktop, real input through `obs dev:cdp` Input.dispatchMouseEvent /
dispatchTouchEvent, on a scratch copy of the test note):

- Reading view: drag Kettle +125/-40 px → `[0.43, 0.35]` → `[0.53, 0.55]` (0.20 = 125/625 px
  plot width), file written, map redrawn with the node at the release point.
- Live Preview: drag Power → `[0.25, 0.54]`, cursor stayed on line 0 (source not opened);
  real Cmd+Z → back to `[0.10, 0.70]`.
- Rename via double click in Live Preview: "Hot Water" → "Heißes Wasser" written quoted in
  the declaration and both links; rendered label updated. Rename to an existing name →
  notice, no change. Anchor drag and rename in reading view (Business → Kundin, link
  updated).
- Touch: drag Tea `[0.63, 0.81]` → `[0.53, 0.94]` after the `touchstart` fix (before:
  `pointercancel`, no edit). Fast synthetic double tap opens the rename dialog.
- Controls: with editing off, a drag changes nothing; clicks on a flowchart node and on the
  map background leave the editor cursor where it was, identical with editing on and off.
- Unit tests: 16, shown to fail when link arrows with labels are not recognised.

**Not verified:** a real iPhone (after commit); a real finger double tap (timing).

## Label offsets (0.3.0, 2026-10-10)

Request: move a component's label relative to its circle so it is not hidden by lines.
The standard stores this in the source: `label [dx, dy]` after the position, measured in
the map's pixel space (default canvas 1100x600, `size [w, h]`). Probed against the
12.1.0 parser: integers only (`label [-70.96, 2.67]` from OWM fails with "Expecting
token of type 'INT'"), must precede the decorator, allowed on pipeline children, **not
allowed on anchors**. Renderer: the label's `x/y` is centre + offset, default `[8, -8]`,
`[18, -18]` with a source-strategy decorator.

Verification (macOS desktop, real CDP drag in Live Preview on a scratch note): dragging the "Hot
Water" label by -80/+15 screen px (scale 1.29 map px per screen px) wrote
`label [-95, 11]` (= default 8 - 103, -8 + 19), position `[0.51, 0.77]` unchanged, label
redrawn at the release point. A second drag replaced it with `label [-43, 11]`; Cmd+Z
restored `[-95, 11]`. 20 unit tests; the replace case fails when replacement is disabled.

## Evolve arrows (0.4.0, 2026-10-10)

Request: lengthen or shorten the red dashed evolve arrow at its free tip. In the
standard the arrow is only `evolve <name> <target evolution>` (the builder draws it at
the component's own visibility), so the gesture changes exactly that one number, drag is
horizontal only. The line is 1 px and shortened by `nodeRadius + 2` before the target; the
tip is grabbed within 10 screen px and the shortening is added back when writing.

Verification (macOS desktop, real CDP drag in Live Preview on a scratch note, ~1.6 map px per screen
px): Kettle `evolve 0.62` → +60 px → `0.72` → -100 px → `0.56`; Kettle's position, the Power
arrow and the editor cursor unchanged; Cmd+Z back to `0.72`. Touch drag of the Power tip by
-60 px: `0.89` → `0.79`. 22 unit tests; the duplicate-evolve guard test fails when the
guard is removed.

## Re-linking (0.5.0, 2026-10-10)

Request: grab a link's end and drop it on another component. Feature (3) of the
original list. Decisions:

- **Grab beside the node, not at it.** The node centre already moves the node, so a link end
  is grabbed on its line 7-28 screen px out; a press on the node still moves it.
- **Either end, any arrow kind.** The text edit swaps the one name in the link line and keeps
  the arrow (`->`, `-.->`, `+'label'>`, ...) and a `; label`.
- **Found while testing:** link lines end at the circle's rim (6 map px before the centre),
  so exact endpoint matching found no owner and the first real drag did nothing. The same
  wrong assumption had made connected lines not follow a node during a move (cosmetic, the
  redraw corrected it). Both now match within 10 map px.

Verification (macOS desktop, real CDP input in Live Preview on a scratch note): target end
`Boiling Water -> Kettle` dropped on Test → `Boiling Water -> Test`; drop into empty space →
no change; Cmd+Z → back to `-> Kettle`; source end `Kaffee Tasse -> Boiling Water` dropped on
Power → `Power -> Boiling Water`; drop creating an existing pair → notice "already linked",
no change; touch drag of an end → `Kaffee Tasse -> Test`; a press on the Kettle centre still
moves Kettle. 26 unit tests; the self-link guard test fails when the guard is removed.

## Delete and create links (0.6.0, 2026-10-10)

Request: hovering the middle of a link shows a delete symbol and a click deletes it
(iPhone: long press); hovering near a node shows "+" and a click creates a link from that
node that is then dragged onto another node with the existing gesture.

- **The standard has no dangling link**, so the click draws a provisional stub only in the
  SVG; the source changes once, when the stub's free end is dropped on another node. That
  keeps the block valid at every moment and makes "add" one undoable edit.
- **Zones** (screen px): node centre moves the node; 7 px to a third of the line (max 28)
  from either end re-links; the rest of the line deletes; 9-22 px around a node centre, off
  the node and off any link band, starts a link.
- **Touch delete needs a long press** (550 ms), a short tap does nothing, so scrolling past a
  map cannot delete a link by accident. A mouse click deletes at once; the notice names the
  link, and Cmd+Z restores it in Live Preview (reading view has no undo).

Verification (macOS desktop, real CDP input in Live Preview on a scratch note): hover gives the red ✕ on
a link's middle, "+" in the ring, crosshair on a link end, the CSS grab cursor on a node and
the arrow on empty space; click on the middle of `Kaffee Tasse -> Tea` deleted it with the
notice; click below Test drew a stub, dragging its end onto Boiling Water wrote
`Test -> Boiling Water` and removed the stub; a press beside Kettle dragged straight onto Tea
wrote `Kettle -> Tea`; touch short tap on a middle changed nothing, a 0.9 s press deleted
`Kettle -> Power`, Cmd+Z restored it; Escape removed a waiting stub. 31 unit tests; the
"already linked" guard of `addLink` fails its test when removed.

## Legend, element add/delete, evolve and inertia delete (0.7.0, 2026-10-10)

Request: delete an evolve line like a link; delete a component from its edit dialog; a
legend on hover (component, anchor, evolve line, the "blocker" line, later also a note) where
a click adds the element.

- **"Blocker" is `inertia` in the standard** (`(inertia)` decorator, rendered as a thick bar).
  Parser facts: must follow a build/buy/outsource decorator, not allowed on anchors.
- **Add = one edit.** Component and anchor ask for the name first, a note for its text, then
  write one line at a free spot (`freeSpot`: 0.08 clearance; anchors along the top, notes low
  right). Evolve and inertia need a component, so the legend arms them and the next press on
  a component applies them (evolve target = evolution + 0.2); Escape disarms.
- **Delete a component** removes its declaration, links and evolve arrow; a pipeline parent is
  refused (the pipeline would dangle and Mermaid rejects it). Two clicks on Delete, the first
  only relabels the button.
- **Found while testing:** the inertia bar lies on the evolve shaft, and the first build
  checked the shaft zone first, so clicking the bar deleted the evolve arrow. The bar, being an
  element under the pointer, now wins.

Verification (macOS desktop, real CDP input in Live Preview on a scratch note): legend appears on hover
with five items; Component → "Milk" → `component Milk [0.50, 0.60]` (0.5/0.5 taken); Anchor →
`anchor Shop owner [0.95, 0.50]`; Note → `note "Check supplier" [0.10, 0.80]`; Evolve armed then
Milk → `evolve Milk 0.80`; Inertia armed then Milk → `(inertia)`; screenshot shows bar, arrow,
anchor and note. Hover: delete cursor on the bar and on the shaft. Click on the bar → inertia
removed, arrow kept; click on the shaft → arrow deleted with notice; touch short tap on
Kettle's shaft kept it, long press deleted it. Double click Boiling Water → dialog
`Delete | Rename | Cancel`; first Delete click relabels, second deletes it and
`Boiling Water -> Kettle`, notice. 41 unit tests; the evolve-removal in `deleteElement` fails
its test when disabled (an earlier test map without an evolve arrow had hidden that).

## Moving notes (0.8.0, 2026-10-10)

Request: notes must be movable too. Mermaid draws a note as a bold `text` whose start is
exactly `note "text" [v, e]`, so the drag rewrites that position; the note is identified by
its text, a duplicated text is refused. Verification (macOS desktop, real CDP input, Live Preview,
scratch note): grab cursor on the note; mouse drag -120/-60 px → `[0.30, 0.49]` →
`[0.45, 0.30]`, redrawn within 2 px of the release point; touch drag → `[0.30, 0.44]`; Cmd+Z
→ `[0.45, 0.30]`. 43 unit tests; the duplicate guard fails its test when removed.

## Inertia position (0.9.0, 2026-10-10)

Request: move the inertia bar along the evolve arrow; no delete symbol on it, the move
symbol instead. **The standard cannot store this** (grammar: `inertia ?= KW_INERTIA`, a flag;
renderer: bar at `nodeRadius + 15` right of the node). Maintainer decision 2026-10-10, options
weighed (comment extension / upstream proposal / keep fixed): **comment extension**, plus
inertia removal by a **toggle in the component dialog** (instead of long press).

- Stored as `%% mp-inertia <name> <evolution>` (parses fine in 12.1, own line or indented),
  inserted right after the component's declaration so it travels with it.
- Applied in `wrapRender` by rewriting the bar's `x1/x2` in the returned SVG string
  (DOMParser/XMLSerializer, only when such a comment exists).
- Debt: an export pipeline (mmdc pre-render) must apply the same transform, or show the default position.
  Upstream proposal (e.g. `(inertia 0.48)`) would remove the extension.

Verification (macOS desktop, real CDP input in Live Preview on a scratch note): inertia added to Kettle
via the legend; cursor over the bar `ew-resize` (no delete cursor); drag +120 px wrote
`%% mp-inertia Kettle 0.36` and the bar was redrawn 1 px from the release point; dialog of
Kettle shows Name, Inertia (on); switching it off removed `(inertia)` and the comment; the
anchor dialog has no inertia toggle; reading view draws Test's bar at the stored 0.94
(803.8 = expected 803.8). 46 unit tests.

## Accelerators, deaccelerators, pipelines (0.10.0, 2026-10-10)

Request: add accelerator, deaccelerator and pipeline as elements, each movable and
deletable through the dialog; then: move the labels of these elements "if the standard
allows it"; and the legend only in the very corners (about the edit button's size), so
elements near a corner stay editable.

- **Syntax measured against 12.1:** `accelerator|deaccelerator Name [v, e]` (spaces and quotes
  fine); `pipeline Parent { component Child [evo] }` needs at least one child (an empty block
  fails to parse), and the parent must be an existing component.
- **Labels:** the grammar has label offsets only on Component and PipelineComponent; the label
  drag was extended to pipeline components. Accelerators, deaccelerators and anchors cannot
  carry one; a note is its text and already moves.
- **Pipeline geometry:** the parent is drawn as a square above the box, not at its declared
  spot. Found while testing: links to the parent then missed it (`centerOf` now uses the
  square), and a press inside the box hit a link end band of the many links to the parent
  (the box now wins; precise link-end hits within 3 px still re-link).
- **Legend in the very corner** (`LEGEND_ZONE` 32 x 32) and kept open while hovered;
  `freeSpot` now also avoids notes and (de)accelerators (two new arrows landed on the same spot).
- Armed actions survive a redraw between arming and the press (the armed svg can be detached).

Verification (macOS desktop, real CDP input in Live Preview on a scratch note; the maintainer was using Obsidian
in parallel, which made one run type into the note): accelerator "Cloud" and deaccelerator
"Habit" added via the legend; drag moved `Cloud` `[0.50, 0.60]` → `[0.56, 0.57]`; its dialog
renamed it to `Cloud move`; Habit deleted via its dialog (two clicks) with notice. Legend:
hidden 60 px inside the corner, visible at 10 px from it, stays open when moved onto an item,
closes in the centre, opens bottom right too. Pipeline armed then Kettle twice:
`pipeline Kettle { Campfire [0.14], Electric [0.24] }`; child drag Electric → `[0.32]`; child
label drag → `label [-5, 24]`; box drag → Kettle `[0.58, 0.14]` → `[0.68, 0.27]` and both
children +0.13; child dialog deleted Electric; parent dialog "Remove pipeline" removed the
block, Kettle unchanged otherwise. 51 unit tests; the last-child rule fails its test when
disabled.

## Link dialog (0.11.0, 2026-10-10)

Request: links have directions and labels, so a click on a link's middle opens a dialog
instead of deleting; delete moves into the dialog; the dialog switches the direction on, off
or around and sets or removes the label. Measured on 12.1: `->`/`-->` plain, `-.->` dashed,
`+>` marker-end, `+<` marker-start, `+<>` both; `; label` is drawn for every kind. The dialog
writes `; label` and normalises an inline flow label into it.

Verification (macOS desktop, real CDP input, Live Preview, scratch note): hover on a link's middle shows
the pointer cursor; click opened "Link Alpha – Beta" (label empty, None (line), options with
the real names); label "orders" + Alpha → Beta saved `Alpha +> Beta; orders`, SVG with
marker-end and the label; reopened prefilled; cleared label + Beta → Alpha saved
`Alpha +< Beta`; touch tap on Beta–Gamma opened its dialog, dashed saved `Beta -.-> Gamma; uses`;
Delete asked once, then deleted with notice and an `[INFO] [mermaid-direct-edit]` console entry.
53 unit tests.

## Code review and refactor (0.12.0, 2026-10-10)

Request: a security and a code review agent, then refactor on their findings with every
test still passing. The security review was interrupted by a session restart and is to be
re-run on this code. The code review (read-only, probes against the real parser) found:

| # | Finding | Status |
|---|---|---|
| 1 | Zones before elements: a click on a component on another's evolve arrow deleted the arrow | fixed (one priority, elements first), E2E `component_on_shaft` fails on 0.11.2 |
| 2 | Source keys restarted at 1 per plugin load: a stale map could resolve to another map's source | fixed (per-instance key prefix) |
| 3 | Names starting with a lowercase keyword (`builder`, `notes`, `title`) written bare, refused by the parser | fixed, tests parse every case |
| 4 | Maps on the 0-100 scale: a drag wrote `[1.00, 1.00]` | such maps are rendered but not editable |
| 5 | A second finger replaced the running gesture | fixed (single active gesture, `isPrimary`) |
| 6 | Unload left timers, dialogs, stub, legend classes, cursors | fixed (`destroy()`), E2E `unload_cleanup` fails on 0.11.2 |
| 7 | All mouse events in Obsidian swallowed for 500 ms after a gesture | fixed (only inside that map), E2E `swallow_scope` fails on 0.11.2 |
| 8 | Unhandled rejections from `apply` | fixed (caught, reported as a notice and in the log) |
| 9 | Removing a pipeline left its components' evolve lines | fixed, tested |
| 10 | `placeInertia` could display an XML parser error | fixed (parsererror guard) |
| 11 | A link's direction read from its inline label (`+'x<y'>` taken as backward) | fixed, tested |
| 12 | Braces in quoted names broke "top level" | fixed, tested |
| 13 | A pipeline drag moved every pipeline's evolution links | fixed (own links only) |
| 14 | Misleading "Open the note itself" for stale maps in the legend | fixed |
| 15 | Hover recomputed every node's centre from the source on each mouse move | fixed (`MapModel` cached per SVG) |
| 16 | Minor gating and stale comments | fixed; maps inside callouts (`> ` prefix) are still refused (clear message since 0.13.0) |

Structure: see CLAUDE.md → "Editing Wardley maps" → Modules. `wardley-editor.ts` went from
1546 to ~420 lines. New tests: 21 unit tests (geometry, review regressions) and the E2E
suite `scripts/e2e-wardley.py` (17 cases), run before the refactor as the baseline (all
passing but one too-strict scroll tolerance) and after it (17/17). The three cases for
findings 1, 6 and 7 were shown to fail against the 0.11.2 build.

## Security review (0.13.0, 2026-10-10)

Re-run on 0.12.0 by a fresh read-only agent (exploit inputs measured in node, the real
parser, a rebuild compared byte for byte with the committed `main.js`). No XSS: Mermaid's
`securityLevel: strict` reaches the pinned instance in both load orders, directives cannot
change it, and the plugin builds no HTML from note text. Findings and what was done:

| # | Sev. | Finding | Status |
|---|---|---|---|
| F1 | medium | `%% mp-inertia a<30k blanks>x` froze Obsidian on every render (quadratic regex; `%%` lines bypass Mermaid's `maxTextSize`), even with editing off | fixed: hand-written linear parser, lines over `MAX_LINE` ignored; test fails on 0.12.0 (1.9 s → < 1 ms) |
| F2 | medium | Cubic `POSITION` and quadratic name regexes: a crafted line froze hover or a legend click; lines of a multi-line `accDescr {…}` were read (and rewritten) as declarations | fixed: `position()`, `readName` with index-based stops, sticky `ARROW`; `editBlocker` leaves maps with lines over 1000 chars, a source over 64 KB, a multi-line `accDescr` or the 0-100 scale untagged; tests fail on 0.12.0 (up to 13.8 s) |
| F3 | low | `locateBlock` searched the whole note: an edit could land in an identical text elsewhere (code example, callout prefix, the host note of an embed) | fixed: only the body of a fenced ```` ```mermaid ```` block of its own (fences inside other code blocks skipped); callout/list maps get a clear refusal; embedded maps are not editable (`mapOf` skips `.markdown-embed`) |
| F4 | info | `placeInertia` re-serialized DOMPurify output (mutation-XSS shape) | fixed: the string is parsed only to read; the bars' numbers are replaced in place (a digit run for a digit run cannot change parsing); a mismatch keeps Mermaid's drawing |
| F5 | low | A forged `data-mp-src` in note HTML triggered a notice and a redraw of every open note per press | fixed: at most one per 10 s |
| F6 | low | Registry capped by count, not size | fixed: identical text shares a key, sources over 64 KB are not registered, 200 entries |
| F7 | info | Non-passive document `touchstart`; another plugin's `window.mermaid` is kept as Obsidian's; cached references outlive unload | accepted: `touchstart` must be non-passive to keep touch drags (touch-action is ignored in SVG); the rest is the same trust as without the plugin |
| F8 | dev | vitest 2.1.9 chain: 2 critical, 1 high, 3 moderate (test runner only) | fixed: vitest 5.0.3 + vite 8.3.4; `npm audit` now 2 low (KaTeX inside Mermaid, needs prior prototype pollution; upstream) |
| F9 | low | The E2E script trashed a fixed path and sent input to whatever note was active | fixed: unique scratch name, never trashes an existing note, aborts when the active note is not the scratch note |

Evidence: `wardley-text.security.test.ts` (16 tests; 14 failed against 0.12.0), 90 unit tests
and strict `tsc` green, E2E 17/17 on the build, inertia placement checked on a live render
(0.75 → x 651 on the 48-852 axis).

## Wardley maps as data (0.15.0, 2026-10-10)

Two CLI commands for scripts and agents: `wardley-read` (the map as JSON) and `wardley-apply`
(bring the map in line with a JSON model). Requested by a script that syncs maps with an
external whiteboard and had its own line parser; that parser misread a pipeline component's
label offset as its position and re-emitted the whole block on write, losing pipelines,
link labels and comments. Contract: `docs/wardley-model.md`.

Decisions:

- **Read from Mermaid's parser AST, not from the editor's line parsers.** The AST is exactly
  what the renderer draws (pipeline components, label signs, flow ports), and every node
  carries its CST range, so line numbers come for free. The model adds only what the AST
  lacks: 0-1 normalisation, `mp-inertia`, and checks Mermaid skips silently (an `evolve` or
  link on an undeclared name draws nothing; a pipeline component's `evolve` is ignored because
  its node id is `Parent_Child`).
- **`@mermaid-js/parser` as an own dependency, pinned to the version Mermaid uses** (2.0.1),
  loaded with a dynamic `import()`: esbuild shares the one copy inside the bundle (main.js
  grew by 24 KB, all of it the new code), and nothing is evaluated before the first call.
- **A block Mermaid cannot parse is `ok:false parse-error`, not a model with errors.** An
  empty model next to an error list is easy to mistake for an empty map, and a consumer that
  syncs would then remove everything elsewhere. The message carries `line L, column C`.
- **Scale by majority.** Mermaid reads each value on its own (at most 1 decimal, else percent),
  so `[1.4, 0.2]` in a decimal map draws at 1.4 % without a complaint. The map's scale is what
  most of its values use; a value on the other scale is an error. The model follows Mermaid's
  reading, so it matches the drawing.
- **Apply never re-emits.** Every difference becomes one of the editor's text edits; new
  helpers `setTitle`, `setMethod`, `deleteNote`. A section absent from the target is left
  alone and an absent field keeps the text, so a consumer that does not know link kinds or
  label offsets cannot erase them. Removals are reported as conflicts unless `allow-delete`.
- **Conflicts do not block the other changes.** A pipeline component off its parent's
  visibility, a kind or pipeline change, a reversed link: reported, not applied; the rest is.

Verification: 19 tests in `wardley-model.test.ts` against the real parser (the requester's
acceptance cases: the Tea Shop map read with pipeline components at their parent's visibility
and label offsets, link labels, forces, inertia; a one-value top-level component and a
negative value as `parse-error` with line numbers; a value above 1 as an error with its line;
apply with the read model is a no-op; moving two elements changes exactly those two lines).
Live in Obsidian 1.14.4: `wardley-read` on the demo map (10 elements, 0 errors); `wardley-apply`
on a scratch note moved two elements, `diff` showed exactly those two lines, a second run
reported `inSync`. Gesture E2E 17/17 on the build (the note lookup is now shared with the editor),
110 unit tests and strict `tsc` green.

## Flowcharts and the shared editor core (0.18.0, 2026-10-11)

Request: after Wardley maps, the standard flowchart, edited the same way; as much of the Wardley
editor reused as possible; and the same "drag a new link into free space creates an element"
gesture for Wardley components. Measured on Mermaid 12.1 before deciding:

- A flowchart has no coordinates (dagre lays it out on every render), so "move a node to a spot"
  does not exist; Mermaid's flowchart parser is the old JISON one and reports no positions in the
  text; the drawing names every node, edge and group by its id (`…-flowchart-<id>-<n>`,
  `data-id`, `…-<subgraph id>`).
- The syntax is richer than wardley-beta: chains, `&` groups, two label forms, 14 bracket shapes
  plus `@{ shape: … }`, `linkStyle` by edge number, `;` separators.

Decisions (the maintainer agreed the plan; two choices were theirs):

- **A1 Text stays the single source.** No layout is stored and no plugin comment is written: in a
  flowchart dragging connects, re-links or moves a node into a group.
- **A2 Identity from the drawing, places from an own scanner, both checked against each other.**
  `flowchart-scan.ts` follows the 12.1 lexer for what the editor needs and predicts Mermaid's
  edge ids; `FlowModel` requires drawing and scan to agree exactly, else the diagram is not
  edited. *Rejected:* a full own parser (too big to keep right), a second Mermaid parse per
  render (async, and still no positions).
- **A3 Smallest possible edit**, statement rewrites only to split a chain or `&` group, edge
  order kept, `linkStyle` carried along (details in CLAUDE.md).
- **A4 A shared editor core and one module set per diagram type.** Moved out of the `wardley-*`
  files: block location, geometry, render tagging, gestures, the editor's event handling, legend,
  dialogs, writing. The Wardley suite proved the refactor (24/24 before, 25/25 after with the new
  gesture).
- **A5 Tests against Mermaid's real flowchart parser**, run in vitest with `happy-dom` as the DOM
  its sanitizer needs (dev dependency only, not bundled).
- **A6 New node ids from the label** (`Check stock` → `CheckStock`).
- **Maintainer: a new link dropped into free space creates a linked element**, in flowcharts
  (`A --> NewNode[Label]`, inside A's group) and in Wardley maps (`component Name [v, e]` at the
  drop point plus `A -> Name`); a tap in the ring still leaves a waiting stub.
- **Maintainer: scope P1 (node and edge dialogs, connect, re-link, legend, direction) + P2
  (groups, colours)** in this round; an agent CLI for flowcharts and further diagram types later.

Found while building:

- **The lexer takes the longest token** (`A&B` is one node id, only `A & B` is a group), and a
  line containing `direction LR` anywhere is read as a direction statement: the scan-vs-drawing
  check catches such a diagram (E2E `not_editable`).
- **Quadratic inline labels:** looking for the closing arrow at every position of a blank run
  took 89 ms on a crafted 61 KB source; skipping the run once brought it under 20 ms (timing test
  fails on the old code).
- **The legend ran out of short diagrams:** a single column of 11 items over a 115 px high
  flowchart put its upper items under the text above, unclickable. It now uses as many rows as
  the diagram's height allows and more columns, sits on the popover layer, and closes once an
  entry is chosen (an armed "Group" otherwise covered the node to be clicked next). This changes
  the Wardley legend too.
- **A group's title lies within the "+" ring of its first node:** titles are elements under the
  pointer and now win over zones, as in Wardley.
- **Obsidian 1.14 adds a hidden `select.is-measuring` after each dropdown;** test code must skip it.

Reviews (fresh agents, read-only; findings verified against Mermaid's parser where possible):

- **Code review: 12 findings, all fixed or answered.** The two high ones: a re-link inside a group
  could pull the new end node into that group (28 of 192 possible re-links on the demo), and
  changing only the words of an inline label could run them into the arrow (`--offer -->` reads
  as a circle end). Medium: a label containing `direction LR` made Mermaid drop its line; moving a
  node between groups could change which definition of another node wins; retitling a group with
  a generated id could swallow a node of the new name; touch swipes could edit. Low: insertions
  after the rest of a line landed in a group; ungroup could hand a node to a sibling group;
  `e1@{ … }` edge metadata blocked editing; a drop back on the stub's own node opened the name
  dialog; the setting text said double-click a link. Its main advice, taken: **a run-time guard**
  (`flowchart-meaning.ts`) that compares the meaning before and after every edit, so a gap
  becomes a refusal. It caught a scanner gap (quoted ellipse labels) on its first run. New tests:
  a re-link sweep (974 re-links across the test diagrams, all correct, none refused), inline
  labels without blanks, direction text, nodes with several definitions.
- **Usability review: 17 findings (4 must-fix), all taken except two left for later.** Must-fix:
  touch swipes could edit, reading view and phones had no undo, a click near a link's end did
  nothing, leaving a group by drag gave no warning. Also: the "+" was invisible, the waiting stub
  looked like a dotted link, new nodes appeared far away unannounced, no right-click route,
  "Reverse"/"Ungroup" dropped typed changes, a group's direction is ignored by Mermaid when its
  nodes link outside, legend icons lost their outline on a dark theme, wording ("Edge" vs "Link",
  "Colour", "ranks"). The Wardley element dialog was moved to the flowchart's Save model in the
  same release (maintainer's go, 11.10.): switching inertia or type no longer writes at once and
  closes the dialog, which had dropped a name typed before (E2E `dialog_saves_all` fails on the
  old dialog; 80 combinations of inertia, type and rename parse and read back, unit test).
  **Left for later:** the legend stays in the bottom corners (a tall flowchart at full width
  needs a scroll to reach it; the right-click menu is the other route).

- **Security review: accept with fixes, both fixed before release.** No XSS (note text reaches the
  DOM only through text-only calls; `innerHTML` holds fixed icons), the sanitized SVG is never
  re-serialized, no Node APIs, `happy-dom` (with provenance, 176/176 signatures verified) is not
  in `main.js`. Findings: **Ungroup could end the code block early** (it dedented continuation
  lines of a multi-line directive, so an indented fence reached column 0 and what followed became
  live Markdown) → Ungroup now dedents only statement starts, and every write and undo of both
  editors refuses text with a line Markdown reads as the block's closing fence (`fenceBreak`,
  CommonMark's rule: up to three spaces); **slow scans on crafted text** (`&` groups multiplied to
  ~1M edges, quadratic link-id and dotted-label lookups, a rescan per node in the link dialog) →
  edges capped at Mermaid's 500, linear lookups, scans cached per text. Its directive input took
  our scanner 3-8 ms before the fix too: the 2.6 s per render it measured is Mermaid's own
  processing of that block. Smaller: Undo checks the tab still shows the same note; the E2E
  driver restores the settings it holds even when the scratch note fails. Tests for each fail on
  the code before the fix (shown in a scratch copy).

Decisions made in the implementation (for the maintainer to confirm or turn around):

- **On touch, flowcharts have no drags at all** (the usability review proposed a long press before
  a drag). Swipes always scroll; everything is reachable with taps: dialogs by double tap,
  re-linking through the link dialog's From/To, groups through the node dialog, links by tapping
  a "+" and then a node. Simpler and safe on a device the tests cannot drive. Wardley maps keep
  their immediate touch drags.
- **"Link" in the interface** for what Mermaid's syntax calls edges, as Mermaid's documentation
  and the Wardley editor do; the code keeps "edge".

## Proposal: classes for wardley-beta (2026-10-13)

Status: interim comment form decided and supported by this plugin since 0.19.0 (next section);
upstream not proposed yet.

**Need.** A map used in a text has to point at parts of itself: "this component", "this
dependency". wardley-beta has no way to mark an element or a link. Annotations number a spot
but do not change how the element looks.

**Decision (maintainer, 2026-10-13): use the statement the standard already has elsewhere,
not a new keyword.** Mermaid styles flowcharts, state and class diagrams with classes:
`classDef <name> <css>` defines a look, `class <ids> <name>` or the shorthand `id:::name`
applies it. Links are styled by `linkStyle <index>` or, since Mermaid 11, by an edge id
(`A e1@--> B`, then `class e1 <name>`). A highlight is then just a class named `highlight`.
The same mechanism carries any later look (muted, new, at risk) without new grammar.

**Proposed extension of the grammar** (for an issue, then a PR to mermaid-js: the wardley
grammar in `@mermaid-js/parser` plus the wardley renderer):

```
classDef highlight stroke:#8000F0,stroke-width:5px
class Kettle highlight
component Kettle [0.30, 0.40] (inertia):::highlight
class Kettle -> Power highlight
```

- `class` takes element names, comma-separated, like flowcharts.
- A link target `A -> B` is our assumption: wardley links have no ids, and their names are
  unique per pair. An alternative closer to flowcharts would be edge ids on wardley links.
- The `:::` shorthand on a declaration follows flowcharts; it is optional in the proposal.

**Interim form, until Mermaid has it: the future statement, commented out.**

```
%% class Kettle highlight
%% class Kettle -> Power highlight
```

- One statement per line, on its own line. Flowcharts reject trailing `%%` comments; wardley
  12.1 accepts one after a declaration, but whether every edit keeps it there is untested.
- Not prefixed `mp-` (unlike `%% mp-inertia`), on purpose: once the grammar supports it,
  deleting `%% ` is the whole migration, in this plugin and in every other renderer that reads
  the form.
- Separate lines, not attached to the declaration: Mermaid keeps structure and look apart
  (`class`, `style`, `linkStyle` are statements of their own), and one map drawn twice can
  carry different highlights.
- A downstream renderer (a print pipeline that draws maps in a book's design) already reads this
  form and refuses an unknown class or name.

The open questions of the proposal (colour, editing, data commands) were decided for 0.19.0,
next section.

## Classes for wardley-beta (0.19.0, 2026-10-13)

The interim form above, drawn, edited and reported by the plugin.

Decisions (maintainer, 2026-10-13), each against the alternatives named:

- **Colour: the theme's accent colour, a `%% classDef` in the map overrides it.** Against a
  `classDef` only (every map would need two lines to show anything), a plugin setting (no path to
  the standard, and per device) and the accent only (no colour per map). The accent follows the
  theme without a redraw, since it is CSS (`--color-accent`).
- **A highlighted element: thick outline and bold label in the colour, no fill.** A fill would
  hide the greys Wardley uses for build, buy and outsource, and the book figures draw the same
  outline. Anchors (text only) get the label colour; a pipeline parent's square gets the outline.
- **A highlighted link: the colour only, same width** (chosen over 3x width). A `classDef` can set
  `stroke-width`. Flow heads take the line's colour through `fill: context-stroke` on Mermaid's
  shared markers; every other link's head keeps its colour because Mermaid draws heads and lines
  in the same colour, and a browser without `context-stroke` drops the rule and keeps Mermaid's.
- **`classDef` is whitelisted:** `stroke`, `stroke-width`, `stroke-dasharray`, `fill`, `color`,
  `font-weight`, with colours (`#hex`, a colour name) and plain numbers only; everything else is
  dropped and reported by `wardley-read`. The style is written into the SVG after DOMPurify ran,
  and Mermaid itself had CSS injection through `classDef`, so nothing with `url()`, functions or
  quotes can pass. The label uses `color`, else the `stroke` colour, so a classDef that only sets
  `stroke` still gives outline and label one colour, like the default look.
- **Target grammar:** element names and links, comma-separated as in flowcharts; a link is
  `A -> B` with exactly `->`, matched as the unordered pair (wardley links have no ids and a pair
  is linked at most once). Only `->`, because a lookup for every arrow form would make the line
  parser super-linear; the book script read it the same way.
- **Edits keep the lines in step:** rename rewrites names in place (the rest of the line keeps its
  spelling), delete drops the element's targets and those of its links (a line left empty goes),
  `unlink` drops the link's, and a re-linked link keeps its class (the target follows the new
  end). New lines go after the last `%% class` line, else at the end of the block.
- **A class needs a target that exists:** `setClass` refuses an undeclared element or a missing
  link, and `wardley-read` reports a line naming nothing as an error, so a misspelt name is
  visible instead of silently drawing nothing.
- **Drawing on the SVG string, like `placeInertia`:** the string is parsed only to read labels and
  line ends; the edit inserts class names and inline styles into existing tags. Nodes by label,
  links by the nodes their ends touch (`END_TOLERANCE`, as the editor). Lookups by name and pair,
  since `%%` lines are outside Mermaid's size limit and a crafted note can hold very many.
- **Data commands:** `classes` on elements and links and `classDefs` in `wardley-read`, `classes`
  in `wardley-apply` (the full set when present). New optional fields, so `schema` stays 1. The
  book-figure consumer reads classes from the model now instead of parsing comments.

Verification (macOS desktop, Obsidian 1.14.4, Mermaid 12.1.0): 28 new unit tests, 5 more from the security review below (text edits
parsed by the real parser and read back through the model, the model and apply, the drawing on
an SVG captured from a live render, timing). Each consistency edit was shown to matter: with its
`editClassTargets` call removed, its test fails. The captured SVG caught a bug before release:
the node pattern also matched the container `<g class="wardley-nodes">`, and the count check
still agreed. Live render in Obsidian (off-screen container, computed styles): the demo map's
highlighted pipeline parent and label in the accent (`rgb(204, 92, 245)`, label bold), the
highlighted link in the accent at 1 px, every other element and link unchanged; with
`%% classDef highlight stroke:#8000F0,stroke-width:4px` shape, label and link in `#8000F0` at
4 px. `wardley-read` on the live notes reports the classes with empty `errors`. The book figures
built from the same maps stayed byte-identical after their script switched to the model. E2E
29/29 with two new cases: `highlight_dialog` (double-click, Highlight on, Save writes
`%% class Gamma highlight`, outline and label drawn in the accent, the neighbour unchanged; off
removes the line) and `highlight_link_dialog` (the link dialog writes `%% class User -> Alpha
highlight`, the line is drawn in the accent in Live Preview and in reading view). A screenshot
of the demo map showed the outline, the bold label and the coloured link as intended. The
flowchart suite was not run: no flowchart or shared editor code changed.

**Security review (0.19.0, same day, before release).** A fresh read-only agent measured exploit
inputs against the real parser and renders. Clean: no note text reaches the drawing outside the
whitelist (1392 property and value combinations plus 20,000 random hostile `classDef` lines; the
insertions removed, the SVG is Mermaid's byte for byte), insertion lands on the right tags even
with markup-like labels, the line parsers are linear, 810 class edits wrote no fence. Fixed:

- **F-A (moderate): drawing was unbounded.** Class lines are comments, which Mermaid's size limit
  does not count, and duplicate links are each drawn: 9000 copies of one link with 750 distinct
  classes took 6.3 s per render and made a 102 MB SVG; one node with 80,000 distinct classes took
  8.4 s (quadratic `includes`). Now at most `MAX_CLASSES` (8) per element, `CLASS_NAME` at most 40
  characters, at most 256 KB inserted per drawing (else Mermaid's drawing), sets instead of lists,
  in `wardley-read` too.
- **F-B (moderate, since 0.15.0): `wardley-apply` could end its block.** An inline-label flow kind
  accepted line breaks, Mermaid parsed the result, and the CLI wrote without `fenceBreak`. The kind
  takes no line break now, and the CLI write goes through `fenceBreak`.
- **F-C (low):** `wardley-apply` `classes` had no cap; now 8 names of at most 40 characters.
- **F-D (info):** link ends were matched against every node on every render with a class line;
  now through a grid of `END_TOLERANCE` cells, and only when a class names a link.

Each regression test fails on the code before the fix (render 2111 ms and 8447 ms before). 320
unit tests; live render and the CLI's refusal of the reviewer's payload re-measured.

## Proposal: groups for wardley-beta (2026-10-13)

Status: interim comment form decided and drawn by this plugin since 0.20.0 (next section);
upstream not proposed yet.

**Need.** Wardley draws boundaries around several components and their links to say "these
belong together": teams in a cell based structure ("Think small (as in teams)" and "Aptitude and
attitude", figures 40 and 41 of *Wardley Maps*, chapter 4), small contracts with their purchasing
method (figure 249, chapter 19), methods for parts of a system (the doctrine "use appropriate
methods"). wardley-beta cannot express this.

**Research (2026-10-13).**

- Wardley gives the shape no notation name; he names what it means: cell, team, contract, method.
- No Wardley tool has it as an element. wardley-beta has `pipeline` (variants of one capability
  on one row). OnlineWardleyMaps and the open Mermaid PR #7696 add `pioneers`, `settlers`,
  `townplanners` as rectangles given by coordinates, not as a set of components.
- Mermaid's words for a set: `group` (architecture-beta), `subgraph` (flowchart), `Boundary`
  (C4), `box` (sequence), `namespace` (class).
- In visualization research the shape is a set drawn over fixed positions: Bubble Sets (Collins,
  Penn, Carpendale 2009, an isocontour), Kelp Diagrams (Dinkla et al. 2012, discs around the
  members joined along links) and KelpFusion (Meulemans et al., a hybrid of hulls and lines).

**Decision (maintainer, 2026-10-13): `group`, one statement per line, name first.**

```
group "Human + AI" Staff, Cup of Tea, Cup, Tea
group Energy Power, Electric Kettle
```

- `group`, not `cell`, `team` or `contract`: those are meanings of a group. Not `zone` or `area`:
  those are coordinate rectangles in OnlineWardleyMaps and in PR #7696, which is a different idea
  (a group follows its components when they move).
- The name first, like `pipeline <name>` and `subgraph <id>`; quoted when it holds blanks.
  Members are element names, comma-separated as in `class`. Several lines with one name make one
  group.
- Links are not listed: a link belongs to a group when both its ends do.
- One line, not a block: a commented block needs `%%` on every line and is fragile to edit.

**Interim form, until Mermaid has it: the statement, commented out.** `%% group "Human + AI" Staff,
Cup of Tea`. Deleting `%% ` is meant to be the migration.

**The drawing.** The area a disc covers when it travels along the group: its members' centres,
the links between two members, and the shortest connections that join members no such link
connects (a spanning tree, as in Kelp diagrams). Inner corners rounded by a closing, holes
filled, the outer edge drawn as a dotted line. A renderer that wants the same look needs nothing
but the members' positions and the links.

## Groups for wardley-beta (0.20.0, 2026-10-13)

Decisions (maintainer, 2026-10-13):

- **Look: a dotted line in the theme's accent colour, close to the members, no label.** Labels
  (Wardley's "Team 1" boxes) are a later step: placing them so they collide with nothing is the
  hard part.
- **Geometry (`wardley-groups.ts`), pure and tested by its properties.** The disc radius is 16 map
  units (a component's circle is 6). A distance field on a 4-unit grid, filled per link only
  within its band (cost follows the band's area, not its bounding box). The closing (grow by 8,
  shrink by 8, measured with an exact Euclidean distance transform) is united with the exact swept
  area, so the outline stays exact wherever nothing is filled: measured within 0.2 units of the
  true radius, while the closing alone shrank it by 0.8 on average. Marching squares with the saddle
  cases resolved by the cell centre; only outer loops are kept, so a ring of links has no hole.
  Douglas-Peucker at 0.75 units, then a centripetal Catmull-Rom spline (the uniform one made hooks
  at sharp corners with unevenly spaced points). A realistic group is about 0.8 KB of path.
- **Inserted, not changed:** one `<g class="mde-groups">` of paths made of numbers, before the
  pipelines, links and nodes (so those draw over it), with `pointer-events="none"`, so every gesture
  reaches what lies inside. No note text is written into the drawing; a group is addressed by its
  index (`data-mde-group`).
- **Members by label, links by the nodes their ends touch**, the same reading as the classes
  (`readDrawing`, shared).
- **Bounded on crafted notes** (the lesson of the 0.19.0 review): 20 groups, 100 members per
  group, a shared budget of distance evaluations per render (`GROUP_BUDGET`, 1M), at most 120,000
  grid cells per group (a group over a larger area gets a coarser grid instead of no boundary),
  256 KB of inserted paths (a group over it is skipped, the others drawn). Measured: 5000 group
  lines plus 200 groups 61 ms, 20 groups spanning the map 44 ms (all drawn, 32 KB).
- **Edits keep the lines in step:** rename rewrites a member in place, deleting an element or a
  pipeline takes its members out, a line left empty goes. `wardley-read` reports `groups` (members
  that exist) and an error for each line naming nothing; `wardley-apply` leaves the lines alone.

Verification (macOS desktop, Obsidian 1.14.4, Mermaid 12.1.0): 19 tests in
`wardley-groups.test.ts` (the line parser, edits read back by the real parser, the model, the
outline by its properties: a single member gives a circle of radius 16, linked members a swept
area with every member inside and the space between two arms outside, unlinked members one area, a
ring no hole, a notch filled while nothing of the swept area is lost; the drawing on the captured
Mermaid SVG changes nothing but the inserted group), each core step shown to matter (rename,
delete, pipeline removal, filled holes, spanning tree, closing: removed, its test fails), timing
cases in `wardley-text.security.test.ts`. The demo map with `%% group "Human + AI" Staff, Cup of
Tea, Cup, Tea`, rendered by Obsidian and rasterized, matches the maintainer's mock-up. E2E 30/30
with the new case `group_render`: the test map's group follows the rename of a member, its boundary
is drawn dotted in the accent colour, takes no pointer events and holds both members but not a
component far away, in Live Preview and in reading view; every other gesture passes with the
boundary on the map.

**Security review (0.20.0, same day, before release): accept.** A fresh read-only agent measured
exploit inputs against real Mermaid renders in a headless Chrome. Clean: no note text reaches the
inserted markup (5000 hostile group sets with markup, quotes, the marker strings, NUL and RTL in
names, members and labels: the inserted block always numbers only, at the right place, and the SVG
otherwise byte-identical); the marker strings occur only as real tags; the transform chain keeps
inertia and classes byte-identical; NaN, infinite and degenerate coordinates are skipped; 8400 fuzzed
edits wrote no fence and changed nothing but group members; `scanTargets` unchanged in behaviour
(20,000 random class lines). Fixed anyway:

- **G-1 (low): a crafted map made the plugin dominate the render** (a snake of 98 members on a
  2700-unit map: about 0.1 s per render with JIT, 0.9 to 1 s without, as in iOS Lockdown Mode),
  mostly in string-keyed contour tracing. Edge points now have integer keys and typed neighbour
  arrays, the budget is 1M and large areas get a coarser grid: 150 to 170 ms became 45 to 80 ms
  for 20 such groups, and the snake is still drawn. Regression test in `wardley-groups.test.ts`.
- **G-2 (info): `wardley-read`'s error list was unbounded** (2 MB of group lines naming missing
  members gave 62 MB of JSON). At most 200 errors, then one entry counting the rest.
- **G-3 (info, older): Mermaid's parser is super-linear in comment lines** (100,000 `%%` lines
  took 11 s in `wardley-read`). Comment lines are blanked before parsing, line numbers kept, the
  text of a multi-line `accDescr` untouched: 50,000 comment lines 1608 ms became 81 ms.
- Noted for consumers: `groups[].name` is note text; a renderer that draws it must escape it.

## Changelog

- **0.20.0 (2026-10-13)** Groups in Wardley maps: `%% group "<name>" <member>, <member>` (the
  proposed `group` statement, commented out until wardley-beta has it) is drawn as a dotted
  boundary in the theme's accent colour around the members and the links between them (a disc
  swept along the group, inner corners rounded). Rename, delete and pipeline removal keep the
  lines in step; `wardley-read` reports `groups`. See "Groups for wardley-beta (0.20.0)". Security
  review before release: a crafted group costs a fraction of what it did, `wardley-read` lists at
  most 200 errors and is no longer slowed by comment lines.

- **0.19.0 (2026-10-13)** Highlights in Wardley maps: `%% class <target> highlight` (Mermaid's
  `class` statement, commented out until wardley-beta has it) is drawn in the theme's accent
  colour, an element with a thick outline and a bold label, a link in colour; `%% classDef`
  gives a map its own colour (checked properties only). Highlight toggle in the element and link
  dialogs; rename, delete, unlink, re-link and pipeline removal keep the lines in step.
  `wardley-read` reports `classes` and `classDefs` (errors for a line naming nothing),
  `wardley-apply` sets `classes`. See "Classes for wardley-beta (0.19.0)". Security review
  before release: drawing bounded on crafted class lines, and `wardley-apply` can no longer write
  a closing fence (a crafted link kind could since 0.15.0).

- **0.18.0 (2026-10-11)** Flowcharts are editable (`flowchart` / `graph`): node dialog (label,
  15 shapes, color, group, delete), link dialog (from/to, label, line, ends, minimum length,
  delete), link from the "+" beside a node (drag, or click then click; into free space: a new
  linked node that flashes once), re-link a link's end, move a node into or out of a group by
  drag, group dialog (title, direction, ungroup, delete with nodes), legend (add a node of a shape,
  new group, direction), right-click menus, Undo in the notice after structural edits, and a
  run-time guard that refuses any edit changing more than it intends. On touch, swipes always
  scroll. Setting "Edit flowcharts". The editor core is shared with Wardley maps (see above).
  Wardley: a new link dropped into free space creates a component there; click, then click links;
  the stub has a handle; the legend adapts to short maps, closes after a choice and has a 44 px
  corner on touch; delete notices have Undo; the element dialog writes name, inertia and type
  together with Save (Rename is gone).

- **0.17.1 (2026-10-11)** With full-width diagrams on (readable line length off), the
  legend's icons were stretched: the full-width rule matched every `svg` inside `.mermaid`,
  and the legend's icons sit there too, so each grew to its row's width (measured 24x16 up
  to 76x51). The rule now takes only the diagram, `.mermaid > svg`. Verified: icons 24x16
  each again, the map still fills the pane in live preview and reading view
  (`max-width: none`, svg width = container width); E2E `legend_corner` now also checks the
  icon size; E2E 24/24.

- **0.17.0 (2026-10-10)** Annotations are editable. Drag a numbered circle
  (`annotation N,[v, e]`) or the box that lists the texts (`annotations [v, e]`); double-click
  a circle or a line in the box for a dialog to change the text or delete it (two clicks). The
  legend adds an annotation (next number, free spot) and a box when the map has none; deleting
  the last annotation removes the box, which would otherwise stay as an empty declaration. The
  box is written where it is drawn, since Mermaid clamps it into the map: a declared
  `[0.98, 0.03]` would otherwise jump on the first drag. Matched by number, not text, because
  the number is what the reader sees and texts may repeat. Verified: 9 cases in
  `wardley-annotations.test.ts` against the real parser (spacing, single quotes and a trailing
  comment survive a move; a note that only looks like an annotation is untouched), a timing
  case per new parser; E2E 23/23 with 5 new cases (circle drag, box drag, text dialog, delete
  from a box line, legend).
  The node dialog also sets a component's type: Default, build, buy, outsource or market,
  i.e. the standard sourcing decorator `(build)` etc. (wardley-beta has it on top-level
  components only, so pipeline components get no dropdown). `setMethod` existed for
  `wardley-apply`; `getMethod` reads the current one for the dropdown. A label on an evolve
  arrow or on inertia was asked for too and left out: wardley-beta has neither (evolve is
  `evolve Name target`, inertia a flag), and the decision was against a plugin-only comment.
  Verified: unit case for `getMethod` (125 tests); E2E `type_dialog` double-clicks a
  component, picks buy (source gets `(buy)`, Mermaid draws `.wardley-buy-overlay`), then
  Default (both gone); E2E 24/24.

- **0.16.1 (2026-10-10)** Maps in a pop-out window are editable. A pop-out has a document of
  its own, and the editor listened only on the main window's: the map rendered and was tagged
  editable, but no press reached it. On top, every `instanceof Element` check was false there,
  because a node in a pop-out belongs to that window's `Element` (now `isElement`, a
  `nodeType` check). The plugin now wires each window: the main one, pop-outs open at load and
  each `window-open`; body classes and the unload cleanup go to every window. Found presenting
  on a second screen. The new E2E case `popout_window` drives a drag with pointer events
  dispatched in the pop-out's own document, since CDP input (`obs dev:cdp`) reaches only the
  main window: it failed on 0.16.0 and passes now; the node dialog opens in the pop-out.
  E2E 18/18, 114 unit tests.

- **0.16.0 (2026-10-10)** Setting "Full-width diagrams without readable line length": with
  Obsidian's readable line length off, every diagram fills the note width (requested for
  presenting on a second screen; coupled to readable line length rather than an own command,
  since the maintainer writes with it on and toggles it with Obsidian's own command). Measured
  before on Obsidian 1.14.4: wardley and pie are `width="100%"` with `max-width` = natural width
  (wardley 900 px), flowchart and sequence a fixed pixel width (Obsidian passes
  `useMaxWidth: false` for them). After: setting off 900 px, on and readable off 1531 px (the
  note width), readable on 700 px (the text column); flowchart 426x70 became 616x101 in a
  616 px pane, i.e. the viewBox keeps the aspect ratio.
  Also for a consumer whose drawing shows inertia bars and arrow heads: `inertiaAt` always read (from
  `%% mp-inertia`, else Mermaid's default bar position, flagged `inertiaAtDefault`; the default
  computed from Mermaid 12.1's renderer constants and checked against a live render: 0.4261,
  0.646, 0.4246 both ways) and applied (writes the comment only when the bar moved); link kinds
  compared by how Mermaid draws them (`->` = `-->`, `+'x'>` = `+> …; x`), a changed kind
  written as given; a pipeline parent's evolution left as written (Mermaid draws its square at
  the centre of its components). The text parsers now also know the inline-label flows
  `+'x'<` and `+'x'<>` of Mermaid's grammar (before, such a link was invisible to every edit).

- **0.15.0 (2026-10-10)** CLI commands `wardley-read` and `wardley-apply`: a Wardley map as
  versioned JSON (schema 1, `docs/wardley-model.md`) and in-place application of a target
  model (see above). Note lookup shared with the editor (`mermaidBlocks`).
  Same day, from the first consumer: an element entry without a `pipeline` key kept as
  written (it was read as "top level" and reported a conflict for every pipeline component of a
  model from a source without pipelines); `visibility` optional for existing elements. The
  E2E unload case re-enabled the pre-rename id `mermaid-pinned` and left the plugin
  unloaded; it uses the current id now, and the teardown re-enables the plugin if it is not
  loaded.

- **0.14.0 (2026-10-10)** Renamed from "Mermaid Pinned" (`mermaid-pinned`) to "Mermaid
  Direct Edit" (`mermaid-direct-edit`): the goal is direct editing of more diagram types,
  Wardley maps are the first. Published as an open-source repository with README, demo
  GIF, CONTRIBUTING, MIT license and CI (type check, tests, build on every pull request).
  The `%% mp-inertia` comment keeps its name, so existing maps stay valid. The E2E script
  takes its CLI from `OBSIDIAN_CLI` and writes its scratch note to the vault root.

- **0.13.0 (2026-10-10)** Security review findings F1-F9 (see above): linear parsers and
  edit limits against freezing crafted notes, writes only into a fenced mermaid block of
  its own, embedded maps not editable, inertia bars placed without re-serializing the SVG,
  bounded source registry, vitest 5, a safer E2E script.

- **0.12.0 (2026-10-10)** Refactor into modules after the code review; findings 1-16 fixed
  (see above); E2E suite `npm run e2e`.

- **0.11.2 (2026-10-10)** A gesture on a map drawn before the last plugin load (its source key is unknown to the new instance) no longer says "Open the note itself" (misleading: it was the note); it redraws and asks to try again. Seen while the maintainer had several tabs of the test note open during a reload.

- **0.11.1 (2026-10-10)** The note no longer jumps to its top after an edit (user report from
  the iPhone, reproduced on the macOS desktop: scroll 3190 → 45 after one drag). Cause: `Editor.replaceRange`
  scrolls the selection, usually far away, into view. Now a direct CodeMirror dispatch
  without scrolling, the scroll position held through the redraw, and the cursor parked on
  the line below the block before the change, so undo (which restores that selection and
  scrolls to it) also stays at the map. Measured after: drag 3190 → 3190, link dialog
  3190 → 3190, Cmd+Z 3190 → 3190, reading-view drag 2641 → 2641. Not yet confirmed on the
  iPhone itself.

- **0.11.0 (2026-10-10)** Link dialog on a link's middle (label, direction, delete) replaces
  delete-on-click.

- **0.10.2 (2026-10-10)** No redraw on unload. A user reported error messages; the console held
  `UnknownDiagramError` exactly at each `plugin:reload` (16:05:03, 16:12:09): unload handed
  `window.mermaid` back to Obsidian's 11.13 and redrew, which cannot draw wardley-beta, so
  every reload or update flashed "Error parsing Mermaid diagram!" until the new instance
  redrew. Diagrams on screen now stay as drawn; the next render after a real disable uses
  Obsidian's Mermaid. Every plugin Notice is also written to the console (`[mermaid-direct-edit]`, `[mermaid-pinned]` before 0.14.0),
  since a Notice disappears and left no trace to diagnose from.

- **0.10.1 (2026-10-10)** An armed legend action (evolve, inertia, pipeline) also accepts a press on a pipeline's box, standing for its parent: adding a second pipeline component no longer needs a hit on the parent's small square.

- **0.10.0 (2026-10-10)** Accelerators, deaccelerators and pipelines: add via legend, move,
  dialogs; pipeline component labels movable; legend only in the very corners.

- **0.9.1 (2026-10-10)** Legend only on demand: shown while the pointer is in the bottom-left
  or bottom-right zone of the map (`LEGEND_ZONE`, 260 x 240 px, at most half the map), in that
  corner; hidden elsewhere and outside the map. Touch: a tap decides the same way. Verified
  with real CDP input: centre hidden, bottom-left visible left, bottom-right visible right,
  bottom middle / top left / outside hidden, a click on the legend in the right corner opened
  "New component"; touch taps likewise, the editor cursor stayed on line 0.

- **0.9.0 (2026-10-10)** Drag the inertia bar along the evolution axis (plugin extension
  `%% mp-inertia`); inertia toggle in the component dialog; clicking the bar no longer deletes.

- **0.8.1 (2026-10-10)** Legend moved to the bottom left corner of the map (user request).

- **0.8.0 (2026-10-10)** Drag a note to move it.

- **0.7.0 (2026-10-10)** Legend to add component, anchor, note, evolve arrow, inertia; delete
  evolve arrows and inertia like links; delete a component from its dialog.

- **0.6.0 (2026-10-10)** Click a link's middle to delete it (touch: long press); press beside a
  node to start a new link. Includes 0.5.1.

- **0.5.1 (2026-10-10)** Arrow cursor over every mermaid diagram. Before, the cursor was
  `auto`, which the browser shows as an I-beam over SVG text (labels, axis and stage
  names). Edit cursors (grab, move, ew-resize, crosshair) are more specific and stay.

- **0.5.0 (2026-10-10)** Drag a link's end onto another node to re-link it. Connected lines
  now follow a dragged node.

- **0.4.0 (2026-10-10)** Drag an evolve arrow's tip to change its target.

- **0.3.0 (2026-10-10)** Drag a component's label to set `label [dx, dy]`.

- **0.2.0 (2026-10-10)** Wardley maps editable: drag anchors/components, double-click or
  double-tap to rename (all references, quoting as the grammar needs). Setting "Edit Wardley
  maps". vitest added for `wardley-text.ts`.

- **0.1.0 (2026-10-10)** First version: Mermaid 12.1.0, accessor swap, classic config,
  `mermaid-pinned:status` CLI command (now `mermaid-direct-edit:status`), settings tab showing the pinned version. Licence
  comments kept in the bundle (`legalComments: "eof"`). Security review accepted it
  (maintainer's security log, 2026-10-10): `securityLevel: strict` holds
  against init/frontmatter overrides, and 12.1.0 closes 9 Mermaid advisories that affect
  Obsidian's 11.13.0. Noted: Mermaid patches are now ours to ship (KaTeX
  GHSA-238p-pmpm-9mq7, low, waits for Mermaid to move to katex >= 0.18.2).
