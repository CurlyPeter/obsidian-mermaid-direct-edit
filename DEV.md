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

## Changelog

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
