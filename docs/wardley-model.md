# Wardley maps as data: `wardley-read` and `wardley-apply`

Two Obsidian CLI commands (Obsidian 1.12+, desktop) for scripts and agents that work with
`wardley-beta` maps in notes: read a map as JSON, and bring a map in line with a JSON model
by editing the text in place. The JSON shape is a contract, versioned by `schema`
(currently **1**). Since plugin version 0.15.0; `inertiaAt` on every element with inertia, `inertiaAtDefault`, and link-kind comparison by drawing since 0.16.0; `classes` and `classDefs` since 0.19.0; `groups` since 0.20.0.

```bash
obsidian mermaid-direct-edit:wardley-read  path="Maps/Tea Shop.md"
obsidian mermaid-direct-edit:wardley-read  source="wardley-beta\ncomponent A [0.4, 0.6]"
obsidian mermaid-direct-edit:wardley-apply path="Maps/Tea Shop.md" model='{"elements":[…]}' dry-run
```

Every answer is one JSON object, `{"ok":true,"data":…}` or
`{"ok":false,"error":{"code":"…","message":"…"}}`. From a script, note that the plain
`obsidian` client can drop an answer that takes more than a few milliseconds when its stdin
is closed, as it is in many script runners; run it with stdin open.

## Which block

- `path=<note>`: the note's fenced ```` ```mermaid ```` blocks whose first statement is
  `wardley-beta` (blank lines and `%%` comments before it are fine). A block inside a callout,
  list or quote does not count. With several, `block=<n>` (1-based) picks one; without it the
  command answers `ambiguous-block`.
- `source=<text>`: the map text itself. `\n` stands for a line break when the value contains
  no real one. `wardley-apply` with `source=` never writes; it returns the new text, so
  `source="wardley-beta"` plus a model makes a new map.

## `wardley-read`

Reading uses Mermaid's own parser (the one the renderer uses), so names, pipelines, labels
and arrows are exactly what Mermaid draws. `line` is 1-based within the block (line 1 is
usually `wardley-beta`). Optional keys are absent when the map has nothing for them.

```jsonc
{
  "path": "Maps/Tea Shop.md", "block": 1,          // only with path=
  "schema": 1,
  "scale": "decimal",                             // how the block writes positions: "decimal" (0-1) or "percent" (0-100)
  "title": "Tea Shop", "accTitle": "…", "accDescr": "…",
  "size": { "width": 800, "height": 600 },
  "stages": [ { "label": "Genesis" }, { "label": "Custom", "boundary": 0.3 }, { "label": "Product / Rental" } ],
  "elements": [
    { "name": "Kettle", "kind": "component", "visibility": 0.38, "evolution": 0.48, "line": 9,
      "label": [-48, -4] },
    { "name": "Campfire Kettle", "kind": "component", "visibility": 0.38, "evolution": 0.37, "line": 11,
      "pipeline": "Kettle", "label": [-40, 22] },
    { "name": "Power", "kind": "component", "visibility": 0.10, "evolution": 0.70, "line": 14,
      "label": [-38, 4], "inertia": true, "inertiaAt": 0.80, "method": "build", "classes": ["highlight"] }
  ],
  "pipelines": [ { "parent": "Kettle", "children": ["Campfire Kettle", "Electric Kettle"], "line": 10 } ],
  "links": [
    { "from": "Public", "to": "Cup of Tea", "kind": "+>", "label": "buys", "flow": true, "line": 19 },
    { "from": "Kettle", "to": "Power", "kind": "-.->", "line": 23, "classes": ["highlight"] }
  ],
  "evolves": [ { "name": "Power", "evolution": 0.92, "line": 26 } ],
  "notes": [ { "text": "Standardising power …", "visibility": 0.15, "evolution": 0.12, "line": 29 } ],
  "forces": [ { "kind": "accelerator", "name": "Open source", "visibility": 0.39, "evolution": 0.91, "line": 30 } ],
  "annotations": [ { "number": 1, "text": "first", "visibility": 0.1, "evolution": 0.2, "line": 32 } ],
  "annotationsBox": { "visibility": 0.05, "evolution": 0.9, "line": 33 },
  "classDefs": [ { "name": "highlight", "style": { "stroke": "#8000F0", "stroke-width": "3px" }, "line": 34 } ],
  "groups": [ { "name": "Human + AI", "members": ["Staff", "Cup of Tea"], "line": 35 } ],
  "errors": [],
  "unsupported": []
}
```

| Field | Meaning |
|---|---|
| `elements` | Anchors and components in source order. `visibility`/`evolution` are always 0-1. |
| `pipeline` | The parent of a pipeline component. Its `visibility` is the parent's: that is where Mermaid draws it (the text gives a pipeline component only its evolution). |
| `label` | `label [dx, dy]`: map pixels relative to the node. Components only. |
| `inertia`, `inertiaAt`, `inertiaAtDefault` | The `(inertia)` decorator. `inertiaAt` (present whenever `inertia` is) is where this plugin draws the bar on the evolution axis: from its `%% mp-inertia <name> <evolution>` comment (other renderers ignore it), else Mermaid's own default position, then with `inertiaAtDefault: true`. Mermaid 12.1 draws the bar 21 px right of the node, 37 px with a build/buy/outsource/market decorator, 19.8 px right of a pipeline parent's square (which sits at the centre of its components), on a chart 804 px wide (`size` width minus 96). |
| `method` | `build`, `buy`, `outsource` or `market`. |
| `links[].kind` | The arrow as written: `->`, `-->`, `-.->`, `+>`, `+<`, `+<>`, `+'label'>`, `+'label'<`, `+'label'<>`. `flow` is set for the `+` arrows. |
| `links[].label` | The `; label` after a link, or the inline label of a flow arrow. |
| `forces` | Accelerators and deaccelerators. |
| `classes` | On elements and links: the classes set by `%% class` lines (see below), in source order. |
| `groups` | `%% group <name> <members>` lines (see below), lines with one name merged: the members that exist, in source order, and the line of the first statement. |
| `classDefs` | `%% classDef <class> <styles>` lines with the properties this plugin applies (`stroke`, `stroke-width`, `stroke-dasharray`, `fill`, `color`, `font-weight`; colours and plain numbers only). A later definition of the same class adds to an earlier one. |
| `errors` | `{line, message}`: the map parses but something in it is wrong (see below). `line` is `null` for the whole map. At most 200, sorted by line; beyond them a last entry with `line: null` counts the rest. |
| `unsupported` | `{line, text}`: a statement Mermaid parses that this model has no field for. Expected empty; it lists what a newer Mermaid added before the model knows it. |

**Positions** are read the way Mermaid reads them: each value on its own, at most 1 is a
decimal, above 1 a percentage. The model is always 0-1. Note that Mermaid's grammar requires
a decimal point (`0.5`, `50.0`; `50` does not parse).

**Classes** are Mermaid's `class` statement, which wardley-beta does not have yet, written as a
comment so Mermaid and other renderers ignore it:

```
%% class Kettle highlight
%% class Kettle -> Power highlight
%% class Staff, "Cup of Tea" muted
%% classDef highlight stroke:#8000F0,stroke-width:3px
```

One statement per line, the class name last (nothing may follow it); a class name is letters,
digits, `_` and `-`, at most 40 characters. Targets are element names
or links, comma-separated; a link is named by its two ends with `->`, in either order, whatever
arrow the link has. Names are written as in a declaration (quoted when they need it). This plugin
draws the class `highlight` in the theme's accent colour and applies a `classDef` to any class;
other class names are carried in the model for consumers. When Mermaid supports `class` for
wardley-beta, deleting `%% ` is meant to be the whole migration.

**Groups** are the proposed `group` statement, written as a comment for now:

```
%% group "Human + AI" Staff, Cup of Tea, Cup, Tea
%% group Energy Power, Electric Kettle
```

The name first (quoted when it holds blanks, at most 60 characters), then the members,
comma-separated element names. Several lines with one name make one group. Links are not listed:
a link belongs to a group when both its ends do. This plugin draws a dotted boundary around the
members and their links; `wardley-apply` leaves the lines alone (removing an element takes it out
of its groups).

**`errors`** (the command still answers `ok:true`):

- a value outside 0-1 in a decimal map (Mermaid reads `1.4` as 1.4 %), a decimal value in a
  0-100 map, a value above 100 (Mermaid refuses the map);
- an element declared twice, a pipeline under an undeclared parent, two pipelines for one
  parent;
- a link or `evolve` naming an undeclared element, an `evolve` on a pipeline component
  (Mermaid draws nothing for either), a pair of elements linked twice, two `evolve` lines
  for one element;
- an `mp-inertia` comment for an element without `(inertia)`;
- a `%% class` line without a target, with an empty name or a class name that is not one
  (letters, digits, `_`, `-`), or naming an element or link the map does not have; a `classDef`
  part the plugin does not apply (`fill:url(…)`, an unknown property);
- a `%% group` line without a name or members, with a link as a member, or naming an element the
  map does not have;
- `Mermaid: …` when the running Mermaid refuses the map for a reason not listed above.

**A block Mermaid cannot parse at all** answers `ok:false` with code `parse-error` and a
message `line L, column C: …` (block-relative, 1-based). Examples: a one-value position
outside a pipeline (`component A [0.37]`), a negative number.

## `wardley-apply`

```
wardley-apply (path=<note> [block=<n>] | source=<text>) model=<json> [dry-run] [tolerance=<n>] [allow-delete]
```

Brings the block in line with the target `model` **by in-place edits only**, the same edits
the graphical editor makes. The block is never re-emitted: every line the model does not
ask to change stays byte-identical, comments included.

**The target model** has the `wardley-read` shape; only these fields are used:

| Section | Entry fields | Identity |
|---|---|---|
| `title` | a string (`""` removes the title) | |
| `elements` | `name`, `evolution`; `visibility` (needed for a new top-level element, optional otherwise, ignored for a pipeline component); optional `kind`, `pipeline`, `label`, `inertia`, `inertiaAt`, `method`, `classes` | name |
| `links` | `from`, `to`; optional `kind`, `label`, `classes` | the unordered pair of names |
| `evolves` | `name`, `evolution` | name |
| `notes` | `text`, `visibility`, `evolution` | the exact text |
| `forces` | `kind`, `name`, `visibility`, `evolution` | kind and name |

- **A section absent from the model is left alone**, with no removals reported for it. A
  section that is present is the full desired set.
- **A field absent from an entry keeps the text's value**: no `kind` keeps the arrow, no
  `label` keeps the link label, no `pipeline` keeps the element in (or out of) its pipeline.
  `label: ""` removes a link label; `method: null` removes the decorator; `pipeline: null`
  means top level. `classes` given is the full set of the entry's classes, at most 8 (`[]`
  removes every class): a class taken away is removed from its `%% class` line (the line goes when it names
  nothing else), a new one is added as a line of its own after the last `%% class` line.
  `classDefs` are not applied.
- A position counts as changed when it differs by more than `tolerance` (default 0.01).
  Positions are written with two decimals.
- **A pipeline parent's evolution is left as written.** Mermaid draws the parent's square at
  the centre of its components, so its own evolution changes nothing in the drawing, and a
  model taken from a drawing cannot know it. Its visibility is applied (the components sit
  at it).
- **`inertiaAt`** is compared with where the bar is drawn now (the comment, else Mermaid's
  default for the element's position after the other changes). Only a bar that moved by more
  than `tolerance` writes or updates the `%% mp-inertia` comment, so a model that keeps the
  default writes nothing. It needs `inertia` on the element (in the text or set by the same
  model), otherwise it is a conflict.
- **Link kinds are compared by how Mermaid draws them**, not by their text. Mermaid 12.1 draws
  a solid or a dashed line, with flow heads forward, backward, both or none:

  | Drawn as | Arrows |
  |---|---|
  | solid, no heads | `->`, `-->` |
  | dashed, no heads | `-.->` |
  | solid, head forward | `+>`, `+'label'>` |
  | solid, head backward | `+<`, `+'label'<` |
  | solid, heads both ways | `+<>`, `+'label'<>` |

  An arrow in the same row as the text's is no change (`+'x'>` against `+> …; x` is the same
  arrow and label). A kind in another row is written as given; when only the label changes,
  the arrow stays as written (an inline-label flow becomes its plain form plus `; label`).
  Without a `label` key, the inline label of the model's arrow counts as its label. Mermaid
  decides the heads from the whole arrow text, so a label containing `<` (`+'a<b'>`) draws
  backward; the comparison follows Mermaid.
- **Additions** (in the model, not in the text) are added: an element after the last
  declaration (a pipeline component into its parent's pipeline, created when needed), a
  link after the last link, an `evolve` after the last one, a note or force after the last
  of its kind.
- **Removals** (in the text, not in the model) are only reported, as conflicts, unless
  `allow-delete` is given. Removing an element also removes its links, its `evolve` line and
  the classes set on it or its links; removing a link removes its classes. A
  rename looks like a removal plus an addition.
- **Conflicts** are differences that are not applied; the other changes still are:
  - a pipeline component whose visibility differs from its parent's (move the parent);
  - an anchor that the model calls a component or the other way round;
  - an element moved into, out of, or between pipelines (only when the entry has a
    `pipeline` key);
  - a link written in the other direction (`B -> A` in the text, `A -> B` in the model);
  - a label offset on an anchor, or `label: null` on a component that has one (removing a
    label offset is not supported);
  - anything an edit refuses (an undeclared link end, a note text with double quotes).

**Answer:**

```jsonc
{
  "path": "Maps/Tea Shop.md", "block": 1,       // only with path=
  "schema": 1,
  "inSync": false,                              // no changes and no conflicts
  "written": true,                              // the note was written
  "changes": [
    { "op": "move", "what": "component Tea", "from": [0.70, 0.81], "to": [0.66, 0.85], "line": 15 },
    { "op": "add", "what": "link Cup of Tea -.-> Milk; needs", "line": 25 },
    { "op": "update", "what": "link Hot Water -> Kettle", "from": { "kind": "->", "label": "limited by" },
      "to": { "kind": "->", "label": "needs" }, "line": 22 }
  ],
  "conflicts": [
    { "what": "component Water", "message": "In the text, not in the model; pass allow-delete to remove it.", "line": 8 }
  ],
  "source": "wardley-beta\n…"                   // the block after the changes
}
```

`op` is `add`, `move`, `update` or `remove`. `line` is the line in the original block, for
an addition the line in the new one. With `dry-run` nothing is written, so `changes` is the
difference between the model and the text; `inSync: true` means they match.

**Writing:** only with `path=` and without `dry-run`, only when something changed, and only
when the running Mermaid parses the result. The note is changed only inside that block; if
the block changed between reading and writing, nothing is written (`stale`).

**Not editable** (`not-editable`): a 0-100 map (the edits write 0-1), and maps beyond the
editor's limits (a line over 1000 characters, a block over 64 KB, a multi-line
`accDescr { … }`).

## Error codes

| Code | When |
|---|---|
| `bad-flag` | missing or contradictory flags, `model=` not JSON, a bad `block=` or `tolerance=` |
| `bad-model` | the model is not the expected shape (the message names the field) |
| `not-found` | no such note |
| `no-block` | the note has no wardley block of its own |
| `ambiguous-block` | several wardley blocks and no `block=` |
| `parse-error` | Mermaid cannot parse the block (message starts with `line L, column C:`) |
| `not-editable` | `wardley-apply` on a map it does not edit (see above) |
| `invalid-result` | the edited map does not parse; nothing was written |
| `stale` | the block changed while applying; nothing was written |

## Versioning

`schema` changes only when a field changes meaning or disappears; new optional fields do not
bump it. Check `schema` before relying on the shape, and `mermaid-direct-edit:info` for the
commands the running build offers.
