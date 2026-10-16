#!/usr/bin/env python3
"""
End-to-end regression for the flowchart editor, driven through the running Obsidian with real
input (Chrome DevTools Protocol via `obs dev:cdp`). Every case acts on a scratch note in Live
Preview and checks the resulting source text. Elements are located from the rendered SVG
(ids and classes Mermaid draws), never from plugin internals.

    python3 -I scripts/e2e-flowchart.py            # all cases
    python3 -I scripts/e2e-flowchart.py group      # cases whose name contains "group"

Needs Obsidian running on this machine with the plugin enabled and "Edit flowcharts" on.
Creates a scratch note with a unique name (`Mermaid Direct Edit Flowchart E2E <time>.md`, vault
root) and trashes it after the run; it never touches an existing note. Input goes to screen
coordinates, so the run stops as soon as the active note is not the scratch note. The note is
reset to the map below before every case, so cases do not depend on each other.
"""
import hashlib
import importlib.util
import json
import os
import re
import time

_spec = importlib.util.spec_from_file_location('e2e_obsidian', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e_obsidian.py'))
E = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(E)
js, click, dblclick, drag_to, mouse, tap, touch, wait = E.js, E.click, E.dblclick, E.drag_to, E.mouse, E.tap, E.touch, E.wait

MAP = """flowchart LR
  Start([Start]) --> Check{Stock?}
  Check -->|yes| Brew[Brew tea]
  Check -- no --> Offer[Offer]
  Offer -.-> Brew
  subgraph Kitchen [Kitchen]
    Brew --> Water[(Water)]
  end
  Water --> Serve(Serve)
  Lone[Lone node]
  subgraph Shop [Shop]
    Pay[/Pay/]
  end
  Serve --> Pay
  linkStyle 0 stroke:#e8590c
"""
# Mermaid's lexer reads a whole line containing "direction LR" as a direction statement, so the
# drawing lacks A and B while the source has them: scan and drawing disagree.
QUIRK = """flowchart LR
  A["direction LR"] --> B
  C --> D
"""
FILLER = '\n\n'.join(f'Filler line {i} so the diagram sits below the top.' for i in range(1, 31))
CONTENT = ('E2E scratch note for mermaid-direct-edit (scripts/e2e-flowchart.py), deleted after the run.\n\n'
           + FILLER + '\n\n```mermaid\n' + MAP + '```\n\n' + FILLER + '\n')
NOTE = E.Scratch('Mermaid Direct Edit Flowchart E2E', CONTENT)

# Locators run inside Obsidian and answer screen coordinates of rendered parts.
LOCATE = r"""
(async()=>{
const ZOOM = __ZOOM__;
const root = ZOOM ? document.querySelector('.mde-zoom') : app.workspace.activeLeaf.view.contentEl.querySelector('.markdown-source-view');
const svg = root && root.querySelector('.mermaid svg[data-mp-kind="flowchart"]');
if (!svg) return JSON.stringify({error: 'no flowchart'});
const mid = r => [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const node = id => [...svg.querySelectorAll('g.node')].find(g => new RegExp('-flowchart-' + esc(id) + '-\\d+$').test(g.id));
const edge = id => svg.querySelector(`path[data-edge][data-id="${id}"]`);
const cluster = id => [...svg.querySelectorAll('g.cluster')].find(c => c.id.endsWith('-' + id));
const at = (p, f) => { const L = p.getTotalLength(); const q = p.getPointAtLength(L * f); const pt = svg.createSVGPoint(); pt.x = q.x; pt.y = q.y; const s = pt.matrixTransform(p.getScreenCTM()); return [Math.round(s.x), Math.round(s.y)]; };
// A point inside the diagram as far as possible from every node, group and edge.
const empty = () => {
  const r = svg.getBoundingClientRect();
  const boxes = [...svg.querySelectorAll('g.node, g.cluster > rect, g.edgeLabel')].map(e => e.getBoundingClientRect()).filter(b => b.width);
  const pts = [...svg.querySelectorAll('path[data-edge]')].flatMap(p => [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1].map(f => at(p, f)));
  let best = null, score = -1;
  for (let x = r.left + 15; x < r.right - 15; x += 12) for (let y = r.top + 15; y < r.bottom - 15; y += 12) {
    let d = Infinity;
    for (const b of boxes) d = Math.min(d, Math.max(b.left - x, 0, x - b.right) + Math.max(b.top - y, 0, y - b.bottom) || (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom ? 0 : Infinity));
    for (const [px, py] of pts) d = Math.min(d, Math.hypot(px - x, py - y));
    if (d > score) { score = d; best = [Math.round(x), Math.round(y)]; }
  }
  return best;
};
const ARG = __ARG__;
const FIXED = __FIXED__;
const compute = () => {
const out = {};
for (const [k, spec] of Object.entries(ARG)) {
  const [what, a, b] = spec;
  if (what === 'node') { const g = node(a); out[k] = g && mid(g.getBoundingClientRect()); }
  else if (what === 'plus') {
    // 7 px off the side farthest from every edge, so the press lands in the ring, not on an edge's end.
    const r = node(a)?.getBoundingClientRect(); if (!r) { out[k] = null; continue; }
    const pts = [...svg.querySelectorAll('path[data-edge]')].flatMap(p => Array.from({length: 21}, (_v, i) => at(p, i / 20)));
    const box = svg.getBoundingClientRect();
    const sides = [[r.left - 7, r.top + r.height / 2], [r.right + 7, r.top + r.height / 2], [r.left + r.width / 2, r.top - 7], [r.left + r.width / 2, r.bottom + 7]]
      .filter(([x, y]) => x > box.left + 2 && x < box.right - 2 && y > box.top + 2 && y < box.bottom - 2);
    const far = ([x, y]) => Math.min(Infinity, ...pts.map(([px, py]) => Math.hypot(px - x, py - y)));
    out[k] = sides.sort((p, q) => far(q) - far(p))[0].map(Math.round); }
  else if (what === 'edge-at') { const p = edge(a); out[k] = p && at(p, b); }
  else if (what === 'edge-to-end') { const p = edge(a); if (!p) { out[k] = null; continue; } const L = p.getTotalLength(); out[k] = at(p, Math.max(0, (L - 8) / L)); }
  else if (what === 'label') { const l = svg.querySelector(`g.edgeLabel g.label[data-id="${a}"]`); out[k] = l && mid(l.getBoundingClientRect()); }
  else if (what === 'cluster-label') { const c = cluster(a); out[k] = c && mid(c.querySelector('.cluster-label').getBoundingClientRect()); }
  else if (what === 'cluster-edge') { const r = cluster(a)?.querySelector(':scope > rect').getBoundingClientRect(); out[k] = r && [Math.round(r.left + r.width / 2), Math.round(r.bottom - 1)]; }
  else if (what === 'cluster-inside') { const r = cluster(a)?.querySelector(':scope > rect').getBoundingClientRect(); out[k] = r && [Math.round(r.left + 8), Math.round(r.bottom - 8)]; }
  else if (what === 'empty') { out[k] = empty(); }
  else if (what === 'corner') { const r = svg.closest('.mermaid').getBoundingClientRect(); out[k] = a === 'left' ? [Math.round(r.left + 10), Math.round(r.bottom - 10)] : [Math.round(r.right - 10), Math.round(r.bottom - 10)]; }
  else if (what === 'legend-item') { const i = svg.closest('.mermaid').querySelector(`.mp-legend [data-mp-add="${a}"]`); out[k] = i && mid(i.getBoundingClientRect()); }
  else if (what === 'menu') { const b = svg.closest('.mermaid').querySelector(':scope > .mde-actions-left .mde-menu-button'); out[k] = b && mid(b.getBoundingClientRect()); }
  else if (what === 'zoom-button') { const b = svg.closest('.cm-embed-block')?.querySelector(':scope > .embed-actions .mde-zoom-button'); out[k] = b && mid(b.getBoundingClientRect()); }
  else if (what === 'scroll') { out[k] = Math.round(root.querySelector('.cm-scroller').scrollTop); }
  else if (what === 'stub-end') { const l = svg.querySelector('line.mp-new-link'); if (!l) { out[k] = null; continue; } const pt = svg.createSVGPoint(); pt.x = +l.getAttribute('x2'); pt.y = +l.getAttribute('y2'); const s = pt.matrixTransform(svg.getScreenCTM()); out[k] = [Math.round(s.x), Math.round(s.y)]; }
}
return out;
};
// Every point has to lie in the visible editor (a point under the tab bar would click a tab):
// scroll the requested points to the middle when they do not.
let out = compute();
if (ZOOM) return JSON.stringify(out);  // the zoom fills the window: nothing to scroll, no other tab under it
const scroller = root.querySelector('.cm-scroller');
const view = scroller.getBoundingClientRect();
const points = () => Object.values(out).filter(v => Array.isArray(v));
const ys = points().map(v => v[1]);
if (!FIXED && ys.length && (Math.min(...ys) < view.top + 20 || Math.max(...ys) > view.bottom - 20)) {
  scroller.scrollTop += (Math.min(...ys) + Math.max(...ys)) / 2 - (view.top + view.bottom) / 2;
  await new Promise(r => setTimeout(r, 400));
  out = compute();
}
// Never hand out a point outside the visible editor: input there would land in another tab or pane.
const off = points().filter(([x, y]) => x < view.left + 2 || x > view.right - 2 || y < view.top + 2 || y > view.bottom - 2);
if (off.length) return JSON.stringify({error: `point outside the visible editor: ${JSON.stringify(off[0])}`});
return JSON.stringify(out);
})()
"""


def locate(**spec):
    """Screen points of rendered parts; scrolls them into view when needed."""
    return _locate(spec, False)


def locate_here(**spec):
    """Like `locate`, without scrolling (a scroll moves the pointer off an open legend)."""
    return _locate(spec, True)


def locate_zoom(**spec):
    """Screen points of rendered parts of the zoomed flowchart."""
    return _locate(spec, True, True)


def _locate(spec, fixed, zoom=False):
    raw = js(LOCATE.replace('__ARG__', json.dumps(spec)).replace('__FIXED__', 'true' if fixed else 'false').replace('__ZOOM__', 'true' if zoom else 'false'))
    try:
        out = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f'locate failed: {raw[:200]}')
    if 'error' in out:
        raise RuntimeError(out['error'])
    missing = [k for k, v in out.items() if v is None]
    if missing:
        raise RuntimeError(f'not found: {missing}')
    return out


def source():
    return js("app.workspace.activeLeaf.view.editor.getValue().match(/```mermaid\\n([\\s\\S]*?)```/)[1]")


def line(pattern):
    m = re.search(pattern, source(), re.M)
    return m.group(0) if m else None


def cursor(x, y):
    mouse('mouseMoved', x, y)
    wait(0.15)
    return js("app.workspace.activeLeaf.view.contentEl.querySelector('.mermaid svg[data-mp-kind]')?.style.cursor ?? ''")


def reset(body=MAP):
    """Puts the map back as it was (a case may have changed it) and the diagram into view."""
    js("(async()=>{const e=app.workspace.activeLeaf.view.editor; const v=e.getValue(); const m=v.match(/```mermaid\\n[\\s\\S]*?```/);"
       " if(m){const from=e.offsetToPos(m.index), to=e.offsetToPos(m.index+m[0].length); e.replaceRange('```mermaid\\n'+" + json.dumps(body) + "+'```', from, to);}"
       " e.setCursor({line:0,ch:0}); await new Promise(r=>setTimeout(r,600));"
       # Live Preview renders only what is near the viewport: bring the block's lines into view first.
       " const n=e.getValue().split('\\n').findIndex(l=>l.startsWith('```mermaid'));"
       " e.scrollIntoView({from:{line:n+12,ch:0},to:{line:n+12,ch:0}},true); await new Promise(r=>setTimeout(r,900));"
       " app.workspace.activeLeaf.view.contentEl.querySelector('.markdown-source-view .mermaid svg')?.scrollIntoView({block:'center'});"
       " await new Promise(r=>setTimeout(r,500)); return 'ok'})()")


def park():
    reset()


# ---- cases ---------------------------------------------------------------------------------

def case_node_label():
    p = locate(n=['node', 'Brew'], s=['scroll'])
    dblclick(*p['n']); wait(0.6)
    title = E.modal_title()
    E.modal('set(m.querySelector("input"), "Make tea"); btn("Save").click()')
    wait()
    after = locate(s=['scroll'])['s']
    got = line(r'^  Check -->\|yes\| Brew.*$')
    return title == 'Edit node "Brew tea"' and got == '  Check -->|yes| Brew[Make tea]' and abs(after - p['s']) <= 5, f'{title!r}; {got}; scroll {p["s"]} -> {after}'


def case_node_shape_colour_undo():
    p = locate(n=['node', 'Serve'])
    dblclick(*p['n']); wait(0.6)
    E.modal('set(sels[0],"hexagon"); set(sels[1],"green"); btn("Save").click()')
    wait()
    shaped, style = line(r'^  Water --> Serve.*$'), line(r'^\s*style Serve .*$')
    E.undo(); wait(1)
    undone = line(r'^  Water --> Serve.*$') == '  Water --> Serve(Serve)' and line(r'^\s*style Serve .*$') is None
    ok = shaped == '  Water --> Serve{{Serve}}' and style == '  style Serve fill:#d3f9d8,stroke:#2b8a3e,color:#1f2933' and undone
    return ok, f'{shaped}; {style}; one undo step restores both: {undone}'


def case_edge_dialog():
    p = locate(m=['edge-at', 'L_Check_Offer_0', 0.5])
    click(*p['m']); wait(0.6)
    title = E.modal_title()
    E.modal('set(m.querySelector("input"), "nope"); set(sels[2], "dotted"); btn("Save").click()')
    wait()
    got = line(r'^  Check .*Offer.*$')
    return title == 'Edit link "Stock?" → "Offer"' and got == '  Check -. nope .-> Offer[Offer]', f'{title!r}; {got}'


def case_edge_label_reverse():
    p = locate(l=['label', 'L_Check_Brew_0'])
    click(*p['l']); wait(0.6)
    title = E.modal_title()
    # The swap button turns From and To around in the dialog; Save writes it with the rest.
    E.modal('m.querySelector(".setting-item .clickable-icon").click(); btn("Save").click()')
    wait()
    got = line(r'^  .*-->\|yes\|.*$')
    return title == 'Edit link "Stock?" → "Brew tea"' and got == '  Brew[Brew tea] -->|yes| Check', f'{title!r}; {got}'


def case_edge_delete_linkstyle():
    p = locate(m=['edge-at', 'L_Start_Check_0', 0.5])
    click(*p['m']); wait(0.6)
    E.modal('const b=btn("Delete"); b.click(); b.click()')
    wait()
    gone = line(r'^  Start.*-->.*$') is None
    kept = line(r'^  Start\(\[Start\]\)$') is not None
    ls = line(r'^\s*linkStyle.*$')
    return gone and kept and ls is None, f'edge gone={gone}; Start kept={kept}; linkStyle={ls}'


def case_relink():
    p = locate(e=['edge-to-end', 'L_Offer_Brew_0'], t=['node', 'Lone'])
    drag_to(p['e'], p['t']); wait()
    got = line(r'^  Offer -\.-> .*$')
    return got == '  Offer -.-> Lone', got


def case_new_edge_stub():
    p = locate(s=['plus', 'Lone'])
    click(*p['s']); wait(0.4)
    p = locate(e=['stub-end'], t=['node', 'Serve'])
    drag_to(p['e'], p['t']); wait()
    got = line(r'^\s*Lone --> Serve$')
    stubs = js('String(document.querySelectorAll("line.mp-new-link").length)')
    return got is not None and stubs == '0', f'{got}; stubs left {stubs}'


def case_new_node_drop():
    p = locate(s=['plus', 'Start'], e=['empty'])
    drag_to(p['s'], p['e']); wait(0.6)
    title = E.modal_title()
    E.type_text('Greet guest'); E.enter(); wait(0.6)
    flashed = js('String(!!document.querySelector(".mermaid svg g.node.mp-flash"))')
    wait(0.7)
    got = line(r'^\s*Start --> GreetGuest\[Greet guest\]$')
    return title == 'New node linked from "Start"' and got is not None and flashed == 'true', f'{title!r}; {got}; flashed={flashed}'


def case_drop_on_origin():
    """A new link dragged out and dropped back on its own node opens nothing: the stub waits."""
    p = locate(s=['plus', 'Lone'], n=['node', 'Lone'])
    drag_to(p['s'], p['n']); wait(0.5)
    title = E.modal_title()
    stubs = js('String(document.querySelectorAll("line.mp-new-link").length)')
    E.key('Escape', 'Escape', 27); wait(0.3)
    return title == '' and stubs == '1', f'dialog={title!r}; stubs={stubs}'


def case_click_click_link():
    """Click beside a node (the stub waits), then click another node: they are linked."""
    p = locate(s=['plus', 'Lone'])
    click(*p['s']); wait(0.4)
    t = locate_here(t=['node', 'Serve'])['t']
    click(*t); wait()
    got = line(r'^\s*Lone --> Serve$')
    return got is not None, got


def case_edge_end_tap():
    """A click on a link's end opens its dialog like its middle (it was dead to clicks)."""
    p = locate(e=['edge-to-end', 'L_Water_Serve_0'])
    click(*p['e']); wait(0.6)
    title = E.modal_title()
    return title == 'Edit link "Water" → "Serve"', title


def case_edge_dialog_relink_undo():
    """The link dialog re-links through To; the notice's Undo takes it back."""
    p = locate(m=['edge-at', 'L_Water_Serve_0', 0.5])
    click(*p['m']); wait(0.6)
    E.modal('set(sels[1], "Lone"); btn("Save").click()')
    wait()
    moved = line(r'^  Water --> .*$')
    undo = js('(()=>{const b=document.querySelector(".notice button.mp-undo"); if(!b) return "none"; b.click(); return "ok"})()')
    wait()
    back = line(r'^  Water --> .*$')
    return moved == '  Water --> Lone' and undo == 'ok' and back == '  Water --> Serve(Serve)', f'{moved}; undo={undo}; {back}'


def case_handles_on_hover():
    """Hovering a node shows "+" marks where a press starts a link; moving away hides them."""
    p = locate(n=['node', 'Lone'], x=['empty'])
    mouse('mouseMoved', *p['n']); wait(0.3)
    shown = int(js('String(document.querySelectorAll(".mermaid svg g.mp-plus-handle").length)'))
    mouse('mouseMoved', *p['x']); wait(0.3)
    gone = int(js('String(document.querySelectorAll(".mermaid svg g.mp-plus-handle").length)'))
    return shown >= 2 and gone == 0, f'shown={shown}; after leaving={gone}'


def case_context_menu():
    """Right-click a node: Obsidian's menu with the node's actions; Delete node deletes it."""
    p = locate(n=['node', 'Lone'])
    mouse('mouseMoved', *p['n'])
    for kind, b in (('mousePressed', 2), ('mouseReleased', 0)):
        E.cdp('Input.dispatchMouseEvent', {'type': kind, 'x': p['n'][0], 'y': p['n'][1], 'button': 'right', 'buttons': b, 'clickCount': 1})
    wait(0.5)
    items = js('JSON.stringify([...document.querySelectorAll(".menu .menu-item-title")].map(t=>t.textContent))')
    js('(()=>{[...document.querySelectorAll(".menu .menu-item")].find(i=>i.textContent.includes("Delete node"))?.click(); return "x"})()')
    wait()
    gone = 'Lone' not in source()
    return 'Edit node…' in items and gone, f'{items}; deleted={gone}'


def case_new_node_in_group():
    """A node created from a node in a group joins that group."""
    p = locate(s=['plus', 'Water'], e=['empty'])
    drag_to(p['s'], p['e']); wait(0.6)
    E.type_text('Kettle'); E.enter(); wait()
    src = source()
    inside = re.search(r'subgraph Kitchen \[Kitchen\]\n(?:.*\n)*?    Water --> Kettle\[Kettle\]\n  end', src) is not None
    return inside, 'Water --> Kettle inside Kitchen' if inside else src


def case_move_into_group():
    p = locate(n=['node', 'Lone'], c=['cluster-inside', 'Shop'])
    drag_to(p['n'], p['c']); wait()
    src = source()
    ok = re.search(r'subgraph Shop \[Shop\]\n    Pay\[/Pay/\]\n    Lone\[Lone node\]\n  end', src) is not None and not re.search(r'^  Lone\[Lone node\]$', src, re.M)
    return ok, 'Lone moved into Shop' if ok else src


def case_move_out_of_group():
    p = locate(n=['node', 'Water'], e=['empty'])
    drag_to(p['n'], p['e']); wait()
    src = source()
    kitchen = re.search(r'subgraph Kitchen \[Kitchen\]\n((?:.*\n)*?)  end', src)
    ok = kitchen is not None and 'Water' not in kitchen.group(1) and re.search(r'^  Brew --> Water\[\(Water\)\]$', src, re.M) is not None
    return ok, kitchen.group(1).strip() if kitchen else src


def case_drag_node_nowhere():
    """A node dropped on another node or its own group springs back: nothing is written."""
    before = source()
    p = locate(n=['node', 'Pay'], o=['node', 'Serve'])
    drag_to(p['n'], p['o']); wait()
    return source() == before, 'unchanged' if source() == before else source()


def case_legend_add_node():
    p = locate(c=['menu'])
    mouse('mouseMoved', *p['c']); wait(0.3)
    item = locate_here(i=['legend-item', 'diamond'])['i']
    click(*item); wait(0.5)
    title = E.modal_title()
    E.type_text('Paid?'); E.enter(); wait()
    got = line(r'^\s*Paid\{Paid\?\}$')
    return title == 'New decision' and got is not None, f'{title!r}; {got}'


def case_legend_direction():
    p = locate(c=['menu'])
    mouse('mouseMoved', *p['c']); wait(0.3)
    item = locate_here(i=['legend-item', 'direction'])['i']
    click(*item); wait(0.5)
    title = E.modal_title()
    E.modal('set(sels[0], "TB"); btn("Save").click()')
    wait()
    return title == 'Flowchart direction' and line(r'^flowchart TB$') is not None, f'{title!r}; {line(r"^flowchart .*$")}'


def case_legend_group():
    p = locate(c=['menu'])
    mouse('mouseMoved', *p['c']); wait(0.3)
    item = locate_here(i=['legend-item', 'group'])['i']
    click(*item); wait(0.4)
    n = locate_here(n=['node', 'Start'])['n']
    click(*n); wait(0.6)
    title = E.modal_title()
    E.type_text('Entry'); E.enter(); wait()
    ok = re.search(r'^  subgraph Entry \[Entry\]\n    Start\n  end$', source(), re.M) is not None
    return title == 'New group around "Start"' and ok, f'{title!r}; group written={ok}'


def case_group_dialog():
    p = locate(l=['cluster-label', 'Kitchen'])
    dblclick(*p['l']); wait(0.6)
    title = E.modal_title()
    E.modal('set(m.querySelector("input"), "Back room"); set(sels[0], "LR"); btn("Save").click()')
    wait()
    head, d = line(r'^  subgraph Kitchen.*$'), line(r'^    direction .*$')
    return title == 'Edit group "Kitchen"' and head == '  subgraph Kitchen [Back room]' and d == '    direction LR', f'{title!r}; {head}; {d}'


def case_group_ungroup():
    # Its bottom border, not its title: with the diagram as wide as the note, Shop's title lies
    # under the block's buttons at the top right (DEV.md 0.24.0); links enter it from the left.
    p = locate(l=['cluster-edge', 'Shop'])
    dblclick(*p['l']); wait(0.6)
    E.modal('btn("Ungroup").click()')
    wait()
    src = source()
    return 'subgraph Shop' not in src and re.search(r'^  Pay\[/Pay/\]$', src, re.M) is not None, src.split('\n')[10:14]


def case_node_delete():
    p = locate(n=['node', 'Offer'])
    dblclick(*p['n']); wait(0.6)
    E.modal('const b=btn("Delete"); b.click(); b.click()')
    wait()
    src = source()
    return 'Offer' not in src and re.search(r'^  Check$', src, re.M) is None, [l for l in src.split('\n') if 'Check' in l]


def case_hover_cursors():
    p = locate(m=['edge-at', 'L_Water_Serve_0', 0.5], e=['edge-to-end', 'L_Water_Serve_0'], s=['plus', 'Lone'], n=['node', 'Lone'], x=['empty'])
    got = {k: cursor(*p[k]) for k in ('m', 'e', 's', 'n', 'x')}
    ok = got['m'] == 'pointer' and got['e'] == 'crosshair' and got['s'].startswith('url("data:image/svg+xml') and got['n'] == '' and got['x'] == ''
    return ok, {k: (v[:20] if v else v) for k, v in got.items()}


# CDP input is too slow for a 400 ms double tap, so the taps are pointer events sent in the page.
DOUBLE_TAP = r"""
(async()=>{
const [x, y] = __XY__;
const el = document.elementFromPoint(x, y);
const o = (type, buttons) => new PointerEvent(type, {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons});
for (let i = 0; i < 2; i++) { el.dispatchEvent(o('pointerdown', 1)); el.dispatchEvent(o('pointerup', 0)); await new Promise(r => setTimeout(r, 80)); }
await new Promise(r => setTimeout(r, 400));
return document.querySelector('.modal-title')?.textContent ?? '';
})()
"""


def case_touch():
    """A double tap opens a node's dialog; swipes from a link's end or a grouped node edit nothing."""
    p = locate(n=['node', 'Lone'])
    title = js(DOUBLE_TAP.replace('__XY__', json.dumps(p['n'])))
    E.close_modals(); wait(0.5)
    before = source()
    p = locate(e=['edge-to-end', 'L_Water_Serve_0'], t=['node', 'Lone'], b=['node', 'Brew'], x=['empty'])
    for (x, y), (tx, ty) in ((p['e'], p['t']), (p['b'], p['x'])):
        touch('touchStart', x, y)
        for i in range(1, 7):
            touch('touchMove', round(x + (tx - x) * i / 6), round(y + (ty - y) * i / 6))
        touch('touchEnd', tx, ty); wait()
    after = source()
    return title == 'Edit node "Lone node"' and after == before, f'{title!r}; unchanged={after == before}'


def case_not_editable():
    """When the drawing and the scan disagree, the editor stays off: a notice, no dialog, no change."""
    reset(QUIRK)
    g = js("(()=>{const g=[...app.workspace.activeLeaf.view.contentEl.querySelectorAll('.mermaid svg g.node')].find(g=>/-flowchart-C-\\d+$/.test(g.id)); const r=g.getBoundingClientRect(); return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()")
    x, y = map(int, g.split())
    js('(()=>{window.__mdeNotices=[]; const o=console.info; console.__mdeInfo=o; console.info=(...a)=>{window.__mdeNotices.push(a.join(" ")); o(...a)}; return "x"})()')
    dblclick(x, y); wait(0.8)
    told = js('JSON.stringify(window.__mdeNotices)')
    js('(()=>{console.info=console.__mdeInfo; return "x"})()')
    title = E.modal_title()
    E.close_modals()
    # Live Preview opens the source on a click the editor did not take; put the cursor back.
    js("(app.workspace.activeLeaf.view.editor.setCursor({line:0,ch:0}),'x')")
    now = source()
    unchanged = now.strip() == QUIRK.strip()
    return 'not editable here' in told and title == '' and unchanged, f'dialog={title!r}; notice={told[:80]}; unchanged={unchanged} {"" if unchanged else repr(now)}'


def case_zoom_add_node():
    """In the zoom the menu adds a node; the zoom draws it anew and the new node flashes there."""
    z = locate(z=['zoom-button'])['z']
    if not z:
        return False, 'no zoom button'
    mouse('mouseMoved', *z); wait(0.2)
    click(*z); wait(1.2)
    if js('String(!!document.querySelector(".mde-zoom svg[data-mp-kind=flowchart]"))') != 'true':
        return False, 'the zoom did not open'
    m = locate_zoom(m=['menu'])['m']
    mouse('mouseMoved', *m); wait(0.3)
    item = locate_zoom(i=['legend-item', 'square'])['i']
    mouse('mouseMoved', m[0], m[1] + 16); mouse('mouseMoved', *item)
    click(*item); wait(0.5)
    title = E.modal_title()
    E.type_text('Zoomed'); E.enter()
    flashed = js('(async()=>{for(let i=0;i<30;i++){if(document.querySelector(".mde-zoom g.node.mp-flash")) return "true"; await new Promise(r=>setTimeout(r,100));} return "false"})()')
    drawn = locate_zoom(n=['node', 'Zoomed'])['n']
    js('(()=>{document.querySelector(".mde-zoom .mde-unzoom-button")?.click(); return "x"})()'); wait(0.4)
    got = line(r'^\s*Zoomed\[Zoomed\]$')
    return title == 'New rectangle' and got is not None and drawn is not None and flashed == 'true', f'{title!r}; {got}; drawn at {drawn}; flashed in the zoom {flashed}'


def case_export_svg_text():
    """`export` draws a flowchart's labels as SVG text, not as HTML in a foreignObject, so librsvg,
    Affinity and Miro show them; no Obsidian variable is left; PNG and SVG carry the block's SHA-256
    and `export-check` says current for both, stale for neither."""
    d = f'E2E flowchart export {time.strftime("%H%M%S")}'
    try:
        src = source()
        want = hashlib.sha256((src[:-1] if src.endswith('\n') else src).encode()).hexdigest()
        svg = E.cli('export', path=NOTE.path, out=f'{d}/flow.svg')
        png = E.cli('export', path=NOTE.path, out=f'{d}/flow.png', scale='1')
        if not (svg.get('ok') and png.get('ok')):
            return False, f'svg {svg}; png {png}'
        base = E.vault_dir()
        with open(os.path.join(base, d, 'flow.svg'), encoding='utf-8') as f:
            text = f.read()
        with open(os.path.join(base, d, 'flow.png'), 'rb') as f:
            facts = E.png_facts(f.read())
        labels = [l for l in ('Brew tea', 'Stock?', 'Lone node', 'Kitchen') if not re.search(r'<(text|tspan)[^>]*>[^<]*' + re.escape(l.split()[0]), text)]
        rsvg = E.rsvg_size(os.path.join(base, d, 'flow.svg'))
        checks = {
            'sha': svg['data']['sha256'] == png['data']['sha256'] == want,
            'no_foreign': '<foreignObject' not in text,
            'labels': not labels,
            'no_vars': 'var(--' not in text,
            'font': bool(re.search(r'font-family:\s*"?Helvetica', text)) and not re.search(r'font-family:\s*[;}]', text),
            'ground': 'class="mde-export-ground"' in text,
            'png': bool(facts) and facts['width'] == svg['data']['width'] and facts['texts'].get('mde-source-sha256') == want and facts['crc_ok'],
            'rsvg': rsvg is None or rsvg == (svg['data']['width'], svg['data']['height']),
        }
        status = [E.cli('export-check', path=NOTE.path, out=f'{d}/flow.{x}').get('data', {}).get('status') for x in ('svg', 'png')]
        failed = [k for k, v in checks.items() if not v]
        return not failed and status == ['current', 'current'], f'{failed or "all checks"}; labels missing {labels}; rsvg {rsvg}; check {status}'
    finally:
        E.trash_path(d)


def case_unload_cleanup():
    p = locate(s=['plus', 'Lone'], c=['menu'])
    click(*p['s']); wait(0.3)
    mouse('mouseMoved', *p['c']); wait(0.3)
    before = js('JSON.stringify({stub:document.querySelectorAll("line.mp-new-link").length, legend:document.querySelectorAll(".mp-legend").length})')
    after = js('(async()=>{await app.plugins.disablePlugin(' + json.dumps(E.PLUGIN_ID) + '); const r={stub:document.querySelectorAll("line.mp-new-link").length, legend:document.querySelectorAll(".mp-legend").length, host:document.querySelectorAll(".mde-host").length, buttons:document.querySelectorAll(".mde-actions, .mde-zoom-button, .mde-share-button").length, body:document.body.classList.contains("mp-flowchart-edit")}; await app.plugins.enablePlugin(' + json.dumps(E.PLUGIN_ID) + '); await new Promise(r=>setTimeout(r,1500)); return JSON.stringify(r)})()')
    return json.loads(before) == {'stub': 1, 'legend': 1} and json.loads(after) == {'stub': 0, 'legend': 0, 'host': 0, 'buttons': 0, 'body': False}, f'before {before}; after unload {after}'


CASES = [
    ('node_label', case_node_label), ('node_shape_colour_undo', case_node_shape_colour_undo),
    ('edge_dialog', case_edge_dialog), ('edge_label_reverse', case_edge_label_reverse), ('edge_delete_linkstyle', case_edge_delete_linkstyle),
    ('relink', case_relink), ('new_edge_stub', case_new_edge_stub), ('new_node_drop', case_new_node_drop), ('new_node_in_group', case_new_node_in_group),
    ('drop_on_origin', case_drop_on_origin), ('click_click_link', case_click_click_link), ('edge_end_tap', case_edge_end_tap),
    ('edge_dialog_relink_undo', case_edge_dialog_relink_undo), ('handles_on_hover', case_handles_on_hover), ('context_menu', case_context_menu),
    ('move_into_group', case_move_into_group), ('move_out_of_group', case_move_out_of_group), ('drag_node_nowhere', case_drag_node_nowhere),
    ('legend_add_node', case_legend_add_node), ('legend_direction', case_legend_direction), ('legend_group', case_legend_group),
    ('group_dialog', case_group_dialog), ('group_ungroup', case_group_ungroup), ('node_delete', case_node_delete),
    ('hover_cursors', case_hover_cursors), ('touch', case_touch), ('zoom_add_node', case_zoom_add_node),
    ('export_svg_text', case_export_svg_text),
    # Replaces the note with a diagram the editor refuses: after every case that needs the test diagram.
    ('not_editable', case_not_editable),
    ('unload_cleanup', case_unload_cleanup),
]

if __name__ == '__main__':
    # Left to right and as wide as the note: the whole diagram fits the window, so every point the
    # cases press is on screen. Native menus off: a macOS menu is not in the page, so the case
    # cannot see or click it.
    E.run(CASES, NOTE, park, settings={'fullWidth': True}, config={'readableLineLength': False, 'nativeMenus': False})
