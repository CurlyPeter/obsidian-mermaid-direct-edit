# Diagrams as files: `export` and `export-check`

Two Obsidian CLI commands (Obsidian 1.12+, desktop) for scripts and agents: write a diagram as a
standalone PNG or SVG file into the vault, and tell whether such a file still matches the diagram
in its note. Any Mermaid diagram type. Since plugin version 0.25.0.

```bash
obsidian mermaid-direct-edit:export       path="Maps/Tea Shop.md" out="Figures/Tea Shop.png"
obsidian mermaid-direct-edit:export       path="Notes/Flow.md" block=2 out="Figures/Flow.svg" background=transparent
obsidian mermaid-direct-edit:export       source="flowchart LR\nA-->B" out="Scratch/ab.png"
obsidian mermaid-direct-edit:export-check path="Maps/Tea Shop.md" out="Figures/Tea Shop.png"
```

Every answer is one JSON object, `{"ok":true,"data":…}` or
`{"ok":false,"error":{"code":"…","message":"…"}}`. From a script, run the `obsidian` client with
stdin open: it can drop an answer that takes more than a few milliseconds otherwise (an export
takes a moment).

A typical build: run `export-check` for every figure, and `export` again for each one that is not
`current`.

**Mermaid permission.** Obsidian 1.13 and later draw Mermaid in a vault only after the user allowed
it once; until then `export` answers `not-permitted`, as the note shows its guard instead of the
diagram.

## Which diagram

- `path=<note>`: the note's fenced ```` ```mermaid ```` blocks of their own, of any diagram type
  (a block inside a callout, list or quote does not count). With several, `block=<n>` (1-based,
  counting every mermaid block of the note) picks one; without it the command answers
  `ambiguous-block`.
- `source=<text>`: the diagram text itself. `\n` stands for a line break when the value contains
  no real one.

## `export`

| Flag | Meaning |
|---|---|
| `out=<file>` | Required. Vault path of the file to write; `.png` or `.svg` decides the format. An existing file is replaced, missing folders are created. Refused: an absolute path, `..` or `.` parts, a hidden folder or file (the config folder among them), the characters `* " < > : \| ?`, any other extension. |
| `scale=<n>` | PNG only: pixels per drawing pixel, 0.1 to 4, default 2. Reduced when the image would exceed 4096 x 4096 pixels in all or 16384 on a side; the answer says what was used. A drawing that would need less than 0.1 is refused (`too-large`): export it as SVG. |
| `background=white\|transparent` | The ground, default `white`. For SVG, white is a rectangle under the drawing (`class="mde-export-ground"`). |
| `width=<px>` | Layout width for diagrams that size themselves to their container (gantt, pie), 320 to 4000, default 1000. Most diagram types ignore it. |

Answer: `{ path, format, width, height, scale?, bytes, sha256, note?, block? }`: the file written,
its size in pixels, for a PNG the scale used, its size in bytes, the checksum it carries, and the
note and block it came from (absent with `source=`).

**What the file shows.** The diagram is drawn anew with the plugin's Mermaid, so the plugin's
extensions are in it (a Wardley map's dragged inertia bar, highlights and other classes, groups).
Three things differ from the drawing in the note, on purpose, so the file looks the same wherever
it is opened (a browser, Affinity, Miro, a mail, librsvg):

- **Labels are SVG text**, never HTML inside a `foreignObject` (`htmlLabels: false` for the
  export), so tools without a browser engine show them and editors can edit them.
- **The font is `Helvetica, Arial, sans-serif`**, available everywhere, instead of the theme's.
  Mermaid measures the labels with it, so they fit their boxes.
- **Colours are written onto the elements.** Every element carries its computed colours, line
  widths and font values in a `style` attribute, and Mermaid's style sheet has no CSS variable
  left (each takes its fallback, never a value of the theme): a highlight in the theme's accent
  colour stays that colour outside Obsidian, and a mark a style takes away (`stroke:none` in a
  Wardley group's `classDef`, a flowchart `style` or `linkStyle`) stays away. A `url()` goes into the file only as a reference
  inside the drawing (`url(#…)`). Always the light drawing: Obsidian's dark mode is a filter over
  the diagram, not other colours.

## `export-check`

| Flag | Meaning |
|---|---|
| `path=<note>` | Required. The note the file was exported from. |
| `out=<file>` | Required. The exported `.png` or `.svg`. |

Answer: `{ status, path, note, block?, sha256? }`, `status` one of

- `current`: the note holds a mermaid block with exactly the text the file was drawn from
  (`block` says which). Still true when other blocks were added or moved around it.
- `stale`: no block of the note has that text any more.
- `missing`: there is no such file.
- `no-checksum`: the file carries no checksum (not written by `export`, or edited since).

**The checksum** is the SHA-256 (hex) of the block text between the fences, without the line
break before the closing fence: on an SVG the root attribute `data-mde-source-sha256`, in a PNG a
`tEXt` chunk with the keyword `mde-source-sha256`. Only the checksum: a file that is mailed or
uploaded does not carry the note's path.

## Errors

| Code | When |
|---|---|
| `bad-flag` | a flag missing, malformed or out of range, or `out=` refused |
| `not-found` | no such note |
| `no-block` | the note has no mermaid block of its own |
| `ambiguous-block` | several blocks and no `block=` |
| `not-permitted` | Mermaid is not allowed in this vault yet (Obsidian 1.13+) |
| `too-large` | the diagram text is over 64 KB, or the drawing is too large for a PNG |
| `render-failed` | Mermaid cannot draw the text (its message follows) |
| `not-a-file` | `out=` names a folder |
