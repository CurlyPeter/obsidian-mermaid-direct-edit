#!/usr/bin/env python3
"""
End-to-end regression for the Wardley editor, driven through the running Obsidian with real
input (Chrome DevTools Protocol via `obs dev:cdp`). Every case acts on a scratch note in Live
Preview and checks the resulting source text. Elements are located from the rendered SVG
(classes Mermaid draws), never from plugin internals, so the test survives refactoring.

    python3 -I scripts/e2e-wardley.py            # all cases
    python3 -I scripts/e2e-wardley.py relink     # cases whose name contains "relink"

Needs Obsidian running on this machine with the plugin enabled and editing on. Creates a
scratch note with a unique name (`Mermaid Direct Edit E2E <time>.md`, vault root) and trashes it after
the run; it never touches an existing note. Input goes to screen coordinates, so the run stops
as soon as the active note is not the scratch note (a click elsewhere would otherwise land in a
real note). Exit 0 when every selected case passed.
"""
import importlib.util
import json
import os
import re

_spec = importlib.util.spec_from_file_location('e2e_obsidian', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e_obsidian.py'))
E = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(E)
obs, js, cdp, mouse, click, drag, key, modal_title, wait = E.obs, E.js, E.cdp, E.mouse, E.click, E.drag, E.key, E.modal_title, E.wait
dblclick, tap, modal = E.dblclick, E.tap, E.modal
PLUGIN_ID = E.PLUGIN_ID

MAP = """wardley-beta
title E2E

anchor User [0.95, 0.50]
component Alpha [0.80, 0.30]
component Beta [0.80, 0.80]
component Gamma [0.50, 0.15]
component Zeta [0.50, 0.28]
component Delta [0.55, 0.55] (inertia)
component Epsilon [0.15, 0.90]
component Pipe [0.30, 0.40]
pipeline Pipe {
  component Pa [0.30]
  component Pb [0.55]
}

User -> Alpha
Alpha -> Beta
Beta -> Epsilon

evolve Gamma 0.40
evolve Delta 0.85

note "A short note" [0.08, 0.04]
accelerator Push [0.65, 0.04]

annotations [0.97, 0.03]
annotation 1,[0.30, 0.70] "First remark"
annotation 2,[0.68, 0.62] "Second remark"

%% group "E2E Group" label Beta, Epsilon
%% group Team label Alpha, Beta
%% classDef team stroke:purple, r:24
%% class Team team
"""
FILLER = '\n\n'.join(f'Filler line {i} so the map sits below the top.' for i in range(1, 41))


# Locators run inside Obsidian and answer screen coordinates of rendered parts.
LOCATE = r"""
(async()=>{
const WHERE = __WHERE__;
const root = WHERE === 'zoom' ? document.querySelector('.mde-zoom') : app.workspace.activeLeaf.view.contentEl.querySelector(WHERE === 'preview' ? '.markdown-preview-view' : '.markdown-source-view');
const svg = root && root.querySelector('.mermaid svg[aria-roledescription="wardley"]');
if (!svg) return JSON.stringify({error: 'no map'});
const ctm = svg.getScreenCTM();
const scr = (x, y) => { const p = svg.createSVGPoint(); p.x = x; p.y = y; const s = p.matrixTransform(ctm); return [Math.round(s.x), Math.round(s.y)]; };
const mid = r => [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
const node = name => [...svg.querySelectorAll('g.wardley-node')].find(g => g.querySelector('text.wardley-node-label')?.textContent.trim() === name);
const center = name => { const g = node(name); if (!g) return null;
  const c = [...g.querySelectorAll(':scope > circle')].filter(c => !c.getAttribute('class')).pop();
  if (c) return [+c.getAttribute('cx'), +c.getAttribute('cy')];
  const r = g.querySelector(':scope > rect'); if (r) return [+r.getAttribute('x') + +r.getAttribute('width') / 2, +r.getAttribute('y') + +r.getAttribute('height') / 2];
  const t = g.querySelector('text'); return [+t.getAttribute('x'), +t.getAttribute('y') + 3]; };
const near = (x, y, c) => c && Math.hypot(x - c[0], y - c[1]) <= 10;
const ARG = __ARG__;
const out = {};
for (const [k, spec] of Object.entries(ARG)) {
  const [what, a, b] = spec;
  if (what === 'node') { const c = center(a); out[k] = c && scr(...c); }
  else if (what === 'label') { const t = node(a)?.querySelector('text.wardley-node-label'); out[k] = t && mid(t.getBoundingClientRect()); }
  else if (what === 'link-mid' || what === 'link-end') {
    const ca = center(a), cb = center(b);
    const l = [...svg.querySelectorAll('line.wardley-link')].find(l => { const x1 = +l.getAttribute('x1'), y1 = +l.getAttribute('y1'), x2 = +l.getAttribute('x2'), y2 = +l.getAttribute('y2'); return (near(x1, y1, ca) && near(x2, y2, cb)) || (near(x1, y1, cb) && near(x2, y2, ca)); });
    if (!l) { out[k] = null; continue; }
    const p1 = scr(+l.getAttribute('x1'), +l.getAttribute('y1')), p2 = scr(+l.getAttribute('x2'), +l.getAttribute('y2'));
    if (what === 'link-mid') out[k] = [Math.round((p1[0] + p2[0]) / 2), Math.round((p1[1] + p2[1]) / 2)];
    else { const sb = scr(...cb); const [from, to] = Math.hypot(p1[0] - sb[0], p1[1] - sb[1]) < Math.hypot(p2[0] - sb[0], p2[1] - sb[1]) ? [p1, p2] : [p2, p1];
      const len = Math.hypot(to[0] - from[0], to[1] - from[1]); out[k] = [Math.round(from[0] + (to[0] - from[0]) / len * 15), Math.round(from[1] + (to[1] - from[1]) / len * 15)]; } }
  else if (what === 'trend-tip' || what === 'trend-mid') {
    const c = center(a); const l = [...svg.querySelectorAll('line.wardley-trend')].find(l => near(+l.getAttribute('x1'), +l.getAttribute('y1'), c));
    if (!l) { out[k] = null; continue; }
    out[k] = what === 'trend-tip' ? scr(+l.getAttribute('x2'), +l.getAttribute('y2')) : scr((+l.getAttribute('x1') * 0.4 + +l.getAttribute('x2') * 0.6), +l.getAttribute('y1')); }
  else if (what === 'inertia') { const l = node(a)?.querySelector('line.wardley-inertia'); out[k] = l && mid(l.getBoundingClientRect()); }
  else if (what === 'note') { const t = [...svg.querySelectorAll('g.wardley-notes > text')].find(t => t.textContent === a); const r = t?.getBoundingClientRect(); out[k] = r && [Math.round(r.left + 12), Math.round(r.top + r.height / 2)]; }
  else if (what === 'force') { const t = [...svg.querySelectorAll('g.wardley-accelerators > text, g.wardley-deaccelerators > text')].find(t => t.textContent.trim() === a); out[k] = t && mid(t.getBoundingClientRect()); }
  else if (what === 'annotation') { const g = [...svg.querySelectorAll('g.wardley-annotation')].find(g => g.textContent.trim() === a); out[k] = g && mid(g.querySelector('circle').getBoundingClientRect()); }
  else if (what === 'annotation-line') { const t = [...svg.querySelectorAll('g.wardley-annotations-box > text')].find(t => t.textContent.startsWith(a + '. ')); const r = t?.getBoundingClientRect(); out[k] = r && [Math.round(r.left + 20), Math.round(r.top + r.height / 2)]; }
  else if (what === 'annotations-box') { const r = svg.querySelector('g.wardley-annotations-box > rect')?.getBoundingClientRect(); out[k] = r && [Math.round(r.right - 8), Math.round(r.bottom - 4)]; }
  else if (what === 'box') { const r = svg.querySelector('rect.wardley-pipeline-box')?.getBoundingClientRect(); out[k] = r && [Math.round(r.left + r.width / 2), Math.round(r.bottom - 4)]; }
  else if (what === 'corner') { const r = svg.closest('.mermaid').getBoundingClientRect(); out[k] = a === 'left' ? [Math.round(r.left + 10), Math.round(r.bottom - 10)] : [Math.round(r.right - 10), Math.round(r.bottom - 10)]; }
  else if (what === 'menu') { const b = svg.closest('.mermaid').querySelector(':scope > .mde-actions-left .mde-menu-button'); out[k] = b && mid(b.getBoundingClientRect()); }
  else if (what === 'zoom-button') { const m = svg.closest('.mermaid'); const b = m.parentElement.matches('.cm-embed-block') ? m.parentElement.querySelector(':scope > .embed-actions .mde-zoom-button') : m.querySelector(':scope > .mde-actions-right .mde-zoom-button'); out[k] = b && mid(b.getBoundingClientRect()); }
  else if (what === 'legend-item') { const i = svg.closest('.mermaid').querySelector(`.mp-legend [data-mp-add="${a}"]`); out[k] = i && mid(i.getBoundingClientRect()); }
  else if (what === 'group-free') {
    // A point inside group `a` (its index) where nothing else is: far from every node (the "+" ring),
    // link and evolve line, not on any drawn element, and in no smaller group.
    const path = svg.querySelector(`g.mde-group[data-mde-group="${a}"] > path.mde-group-boundary`);
    if (!path) { out[k] = null; continue; }
    const area = p => { const b = p.getBBox(); return b.width * b.height; };
    const smaller = [...svg.querySelectorAll('g.mde-group > path.mde-group-boundary')].filter(o => o !== path && area(o) < area(path));
    const centres = [...svg.querySelectorAll('g.wardley-node')].map(g => center(g.querySelector('text.wardley-node-label')?.textContent.trim())).filter(Boolean).map(c => scr(...c));
    const lines = [...svg.querySelectorAll('line.wardley-link, line.wardley-trend')].map(l => [scr(+l.getAttribute('x1'), +l.getAttribute('y1')), scr(+l.getAttribute('x2'), +l.getAttribute('y2'))]);
    const seg = (p, [u, v]) => { const dx = v[0] - u[0], dy = v[1] - u[1], len = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / len)); return Math.hypot(p[0] - u[0] - t * dx, p[1] - u[1] - t * dy); };
    const b = path.getBBox(); let best = null;
    for (let i = 1; i < 40; i++) for (let j = 1; j < 40; j++) {
      const pt = new DOMPoint(b.x + b.width * i / 40, b.y + b.height * j / 40);
      if (!path.isPointInFill(pt) || smaller.some(o => o.isPointInFill(pt))) continue;
      const s = scr(pt.x, pt.y), el = document.elementFromPoint(...s);
      if (!el || !svg.contains(el) || el.closest('g.wardley-node, g.wardley-notes, g.wardley-annotation, g.wardley-annotations-box, g.wardley-accelerators, g.wardley-deaccelerators, rect.wardley-pipeline-box, text')) continue;
      const score = Math.min(Math.min(...centres.map(c => Math.hypot(c[0] - s[0], c[1] - s[1]))) - 30, Math.min(Infinity, ...lines.map(l => seg(s, l))) - 14);
      if (score > 0 && (!best || score > best[0])) best = [score, s];
    }
    out[k] = best && best[1];
  }
  else if (what === 'menu-item') { const i = [...document.querySelectorAll('.menu .menu-item')].find(i => i.querySelector('.menu-item-title')?.textContent === a); out[k] = i && mid(i.getBoundingClientRect()); }
  else if (what === 'notice-button') { const b = [...document.querySelectorAll('.notice button')].find(b => b.textContent === a && b.closest('.notice').querySelector('.mp-group-notice')); out[k] = b && mid(b.getBoundingClientRect()); }
  else if (what === 'group-label') { const t = [...svg.querySelectorAll('text.mde-group-label')].find(t => t.textContent === a); out[k] = t && mid(t.getBoundingClientRect()); }
  else if (what === 'plus') { const c = center(a); const s = scr(...c); out[k] = [s[0], s[1] + 15]; }
  else if (what === 'scroll') { out[k] = Math.round(root.querySelector('.cm-scroller').scrollTop); }
}
return JSON.stringify(out);
})()
"""


def locate(where='source', **spec):
    """Screen points of rendered parts of the map in the note (`source`, `preview`) or in the zoom."""
    raw = js(LOCATE.replace('__ARG__', json.dumps(spec)).replace('__WHERE__', json.dumps(where)))
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f'locate failed: {raw[:200]}')


def source():
    raw = js("app.workspace.activeLeaf.view.editor.getValue().match(/```mermaid\\n([\\s\\S]*?)```/)[1]")
    return raw


def line(pattern):
    m = re.search(pattern, source(), re.M)
    return m.group(0) if m else None


def park():
    """Cursor to line 0 and the map into view, as a user would have it."""
    js("(async()=>{const l=app.workspace.activeLeaf; l.view.editor.setCursor({line:0,ch:0});"
       "l.view.editor.scrollIntoView({from:{line:84,ch:0},to:{line:84,ch:0}},true); await new Promise(r=>setTimeout(r,900));"
       "l.view.contentEl.querySelector('.markdown-source-view .mermaid svg')?.scrollIntoView({block:'center'});"
       "await new Promise(r=>setTimeout(r,600)); return 'ok'})()")


CONTENT = ('E2E scratch note for mermaid-direct-edit (scripts/e2e-wardley.py), deleted after the run.\n\n'
           + FILLER + '\n\n```mermaid\n' + MAP + '```\n\n' + FILLER + '\n')
SCRATCH = E.Scratch('Mermaid Direct Edit E2E', CONTENT)

# ---- cases ---------------------------------------------------------------------------

def case_node_drag():
    p = locate(n=['node', 'Alpha'], s=['scroll'])
    drag(*p['n'], 40, 30); wait()
    after = locate(s=['scroll'])['s']
    got = line(r'^component Alpha .*$')
    return got != 'component Alpha [0.80, 0.30]' and abs(after - p['s']) <= 5, f'{got}; scroll {p["s"]} -> {after}'


def case_undo():
    js('(app.workspace.activeLeaf.view.editor.focus(),"f")')
    key('z', 'KeyZ', 90, 4, ['undo']); wait(1)
    got = line(r'^component Alpha .*$')
    return got == 'component Alpha [0.80, 0.30]', got


def case_label_drag():
    p = locate(l=['label', 'Beta'])
    drag(*p['l'], -60, 20); wait()
    got = line(r'^component Beta .*$')
    return bool(got and re.search(r'label \[-?\d+, -?\d+\]', got)), got


def case_evolve_tip():
    p = locate(t=['trend-tip', 'Gamma'])
    drag(*p['t'], 60, 0); wait()
    got = line(r'^evolve Gamma .*$')
    return bool(got and got != 'evolve Gamma 0.40'), got


def case_inertia_drag():
    p = locate(b=['inertia', 'Delta'])
    drag(*p['b'], 50, 0); wait()
    got = line(r'^%% mp-inertia Delta .*$')
    return bool(got), got


def case_evolve_delete():
    p = locate(m=['trend-mid', 'Delta'])
    click(*p['m']); wait()
    return line(r'^evolve Delta .*$') is None, line(r'^evolve .*$')


def case_relink():
    p = locate(e=['link-end', 'Beta', 'Epsilon'], d=['node', 'Gamma'])
    drag(*p['e'], p['d'][0] - p['e'][0], p['d'][1] - p['e'][1]); wait()
    got = line(r'^Beta -> .*$')
    return got == 'Beta -> Gamma', got


def case_link_dialog():
    p = locate(m=['link-mid', 'Alpha', 'Beta'])
    click(*p['m']); wait(0.6)
    title = modal_title()
    js('(()=>{const s=document.querySelector(".modal select"); s.value="forward"; s.dispatchEvent(new Event("change"));'
       ' const i=document.querySelector(".modal input"); i.value="feeds"; i.dispatchEvent(new Event("input"));'
       ' [...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Save").click(); return "x"})()')
    wait()
    got = line(r'^Alpha .*Beta.*$')
    return title.startswith('Link') and got == 'Alpha +> Beta; feeds', f'{title!r}; {got}'


def case_new_link_stub():
    p = locate(s=['plus', 'Gamma'])
    click(*p['s']); wait(0.4)
    stub = js('(()=>{const l=document.querySelector("line.mp-new-link"); if(!l) return "none"; const svg=l.ownerSVGElement;'
              ' const pt=svg.createSVGPoint(); pt.x=+l.getAttribute("x2"); pt.y=+l.getAttribute("y2");'
              ' const s=pt.matrixTransform(svg.getScreenCTM()); return Math.round(s.x)+" "+Math.round(s.y)})()')
    if stub == 'none':
        return False, 'no stub drawn'
    sx, sy = map(int, stub.split())
    d = locate(d=['node', 'Delta'])['d']
    drag(sx, sy, d[0] - sx, d[1] - sy); wait()
    got = line(r'^Gamma -> Delta$')
    return got is not None, got


def case_new_component_drop():
    """A new link dragged from the "+" ring into free space asks for a name and creates the
    component there, linked from the start (0.18.0, the same gesture as in flowcharts)."""
    p = locate(s=['plus', 'Gamma'], g=['node', 'Gamma'])
    sx, sy = p['s']
    drag(sx, sy, 0, p['g'][1] - sy - 110); wait(0.6)
    title = modal_title()
    cdp('Input.insertText', {'text': 'Fresh'})
    key('Enter', 'Enter', 13); wait()
    comp, link = line(r'^component Fresh .*$'), line(r'^Gamma -> Fresh$')
    m = re.match(r'component Fresh \[(\d\.\d+), (\d\.\d+)\]$', comp or '')
    above = bool(m) and float(m.group(1)) > 0.6 and abs(float(m.group(2)) - 0.15) < 0.05
    return title == 'New component linked from "Gamma"' and link is not None and above, f'{title!r}; {comp}; {link}'


def case_click_click_link():
    """Click beside a component (the stub waits), then click another one: they are linked (0.18.0)."""
    p = locate(s=['plus', 'Gamma'])
    click(*p['s']); wait(0.4)
    t = locate(t=['node', 'Epsilon'])['t']
    click(*t); wait()
    got = line(r'^Gamma -> Epsilon$')
    return got is not None, got


def case_note_drag():
    p = locate(n=['note', 'A short note'])
    drag(*p['n'], 80, -40); wait()
    got = line(r'^note "A short note" .*$')
    return got != 'note "A short note" [0.08, 0.04]', got


def case_force_drag():
    p = locate(f=['force', 'Push'])
    drag(*p['f'], -50, -30); wait()
    got = line(r'^accelerator Push .*$')
    return got != 'accelerator Push [0.65, 0.04]', got


def case_annotation_drag():
    p = locate(a=['annotation', '1'])
    drag(*p['a'], 60, -40); wait()
    got = line(r'^annotation 1,.*$')
    return bool(got) and got != 'annotation 1,[0.30, 0.70] "First remark"' and got.endswith('"First remark"'), got


def case_annotations_box_drag():
    p = locate(b=['annotations-box'])
    drag(*p['b'], 250, 180); wait()
    got = line(r'^annotations .*$')
    return bool(got) and got != 'annotations [0.97, 0.03]', got


def case_annotation_dialog():
    p = locate(a=['annotation', '2'])
    click(*p['a'], 1); click(*p['a'], 2); wait(0.6)
    title = modal_title()
    js('(()=>{const i=document.querySelector(".modal input"); i.value="Changed remark"; i.dispatchEvent(new Event("input"));'
       ' [...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Save").click(); return "x"})()')
    wait()
    got = line(r'^annotation 2,.*$')
    return title == 'Edit annotation 2' and got == 'annotation 2,[0.68, 0.62] "Changed remark"', f'{title!r}; {got}'


def case_annotation_delete():
    # Double click on the annotation's line in the box; Delete needs a confirming second click.
    p = locate(l=['annotation-line', '1'])
    click(*p['l'], 1); click(*p['l'], 2); wait(0.6)
    title = modal_title()
    js('(()=>{const b=[...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Delete"); b.click(); b.click(); return "x"})()')
    wait()
    return title == 'Edit annotation 1' and line(r'^annotation 1,.*$') is None and line(r'^annotations .*$') is not None, title


def case_legend_annotation():
    p = locate(c=['menu'])
    mouse('mouseMoved', *p['c']); wait(0.3)
    item = locate(i=['legend-item', 'annotation'])['i']
    if not item:
        return False, 'legend not shown'
    click(*item); wait(0.5)
    title = modal_title()
    cdp('Input.insertText', {'text': 'Added remark'})
    key('Enter', 'Enter', 13); wait()
    got = line(r'^annotation \d+,.*"Added remark"$')
    return title == 'New annotation' and got is not None, f'{title!r}; {got}'


def case_pipeline_box_drag():
    p = locate(b=['box'])
    drag(*p['b'], 50, 0); wait()
    pa, pb = line(r'^  component Pa .*$'), line(r'^  component Pb .*$')
    return pa != '  component Pa [0.30]' and pb != '  component Pb [0.55]', f'{pa} | {pb}'


def case_rename_dialog():
    p = locate(n=['node', 'Epsilon'])
    click(*p['n'], 1); click(*p['n'], 2); wait(0.6)
    title = modal_title()
    js('(()=>{const i=document.querySelector(".modal input"); i.value="Omega"; i.dispatchEvent(new Event("input"));'
       ' [...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Save").click(); return "x"})()')
    wait()
    return title.startswith('Edit') and line(r'^component Omega .*$') is not None and 'Epsilon' not in source(), title


def case_type_dialog():
    """The node dialog's Type dropdown writes the sourcing decorator, Mermaid draws its ring, Default removes it."""
    def pick(value):
        p = locate(n=['node', 'Alpha'])
        click(*p['n'], 1); click(*p['n'], 2); wait(0.6)
        shown = js('(()=>{const s=document.querySelector(".modal select"); if(!s) return "none"; const v=s.value;'
                   ' s.value=' + json.dumps(value) + '; s.dispatchEvent(new Event("change"));'
                   ' [...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Save").click(); return v})()')
        wait(); park()
        ring = js('String(!!app.workspace.activeLeaf.view.contentEl.querySelector(".mermaid svg .wardley-buy-overlay"))')
        return shown, line(r'^component Alpha .*$'), ring
    shown1, got1, ring1 = pick('buy')
    shown2, got2, ring2 = pick('default')
    ok = (shown1 == 'default' and got1 == 'component Alpha [0.80, 0.30] (buy)' and ring1 == 'true'
          and shown2 == 'buy' and got2 == 'component Alpha [0.80, 0.30]' and ring2 == 'false')
    return ok, f'{shown1} -> {got1} ring={ring1}; {shown2} -> {got2} ring={ring2}'


def case_dialog_saves_all():
    """Name, type and inertia changed in one dialog are written together with Save (0.18.0: switching
    the type used to write at once and close the dialog, losing the name typed before)."""
    p = locate(n=['node', 'Delta'])
    click(*p['n'], 1); click(*p['n'], 2); wait(0.6)
    js('(()=>{const m=document.querySelector(".modal"); const i=m.querySelector("input[type=text], input:not([type])");'
       ' i.value="Delta two"; i.dispatchEvent(new Event("input"));'
       ' const s=m.querySelector("select:not(.is-measuring)"); s.value="build"; s.dispatchEvent(new Event("change"));'
       ' m.querySelector(".checkbox-container").click(); return "x"})()')
    still_open = modal_title()
    js('(()=>{[...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Save").click(); return "x"})()')
    wait()
    got = line(r'^component Delta two .*$')
    leftover = line(r'^%% mp-inertia Delta.*$')
    ok = still_open == 'Edit "Delta"' and got == 'component Delta two [0.55, 0.55] (build)' and leftover is None
    return ok, f'open after changes: {still_open!r}; {got}; inertia comment: {leftover}'


def visible_legends():
    return int(js('String(document.querySelectorAll(".mp-legend.is-visible").length)') or 0)


def case_legend_menu():
    """The legend opens from the menu button at the top left and adds a note. The bottom corners,
    where it opened before 0.24.0, open nothing; leaving the menu closes it after a moment."""
    p = locate(c=['corner', 'left'], r=['corner', 'right'], m=['menu'], far=['node', 'Alpha'])
    mouse('mouseMoved', *p['c']); wait(0.4)
    mouse('mouseMoved', *p['r']); wait(0.4)
    corners = visible_legends()
    mouse('mouseMoved', *p['m']); wait(0.3)
    opened = visible_legends()
    mouse('mouseMoved', *p['far']); wait(0.7)
    left = visible_legends()
    mouse('mouseMoved', *p['m']); wait(0.3)
    item = locate(i=['legend-item', 'note'])['i']
    if corners or opened != 1 or left or not item:
        return False, f'corners opened {corners}; on the button {opened}; after leaving {left}; item {item}'
    # Every icon keeps its 24x16, also with full-width diagrams on (0.17.1: they were stretched).
    icons = js("JSON.stringify([...new Set([...app.workspace.activeLeaf.view.contentEl.querySelectorAll('.mp-legend svg')]"
               ".map(s=>{const r=s.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height)}))])")
    if icons != '["24x16"]':
        return False, f'legend icons {icons}'
    # The way from the button down to the item crosses the gap between them: it must stay open.
    mouse('mouseMoved', p['m'][0], p['m'][1] + 16); mouse('mouseMoved', *item); wait(0.1)
    click(*item); wait(0.5)
    title = modal_title()
    cdp('Input.insertText', {'text': 'Added note'})
    key('Enter', 'Enter', 13); wait()
    return title == 'New note' and line(r'^note "Added note" .*$') is not None, title


def case_menu_tap():
    """A finger has no hover: a tap on the menu button opens the legend, the next closes it, a tap
    elsewhere closes it too, and a tap on an item acts."""
    p = locate(m=['menu'], far=['node', 'Alpha'])
    tap(*p['m']); wait(0.4)
    first = visible_legends()
    tap(*p['m']); wait(0.4)
    second = visible_legends()
    tap(*p['m']); wait(0.4)
    E.tap(p['far'][0] + 60, p['far'][1] + 60); wait(0.4)
    elsewhere = visible_legends()
    tap(*p['m']); wait(0.4)
    item = locate(i=['legend-item', 'anchor'])['i']
    tap(*item); wait(0.6)
    title = modal_title()
    E.close_modals()
    ok = first == 1 and second == 0 and elsewhere == 0 and title == 'New anchor'
    return ok, f'tap: {first}; again: {second}; elsewhere: {elsewhere}; item: {title!r}'


def case_buttons():
    """Live Preview: "Zoom in" first in Obsidian's own toolbar of the block, before "Edit this
    block", as on an image; the menu button at the top left, level with them and the same size."""
    r = json.loads(js('JSON.stringify((()=>{const b=app.workspace.activeLeaf.view.contentEl.querySelector(".markdown-source-view .cm-embed-block.cm-lang-mermaid");'
                      ' const t=[...b.querySelectorAll(":scope > .embed-actions > .embed-action")].map(a=>a.getAttribute("aria-label"));'
                      ' const r=e=>{const x=e?.getBoundingClientRect(); return x && [Math.round(x.top), Math.round(x.width), Math.round(x.height)]};'
                      ' return {toolbar:t, menu:r(b.querySelector(".mde-menu-button")), zoom:r(b.querySelector(".embed-actions .mde-zoom-button")), edit:r(b.querySelector(".edit-block-button"))}})())'))
    ok = r['toolbar'] == ['Zoom in', 'Edit this block'] and r['menu'] is not None and r['menu'] == r['zoom'] == r['edit']
    return ok, json.dumps(r)


# ---- the zoom ----------------------------------------------------------------------------

ZOOM_STATE = r"""JSON.stringify((()=>{const z=document.querySelector(".mde-zoom"); if(!z) return {open:false};
const p=z.querySelector(".mde-zoom-panel").getBoundingClientRect(), s=z.querySelector(".mde-zoom-diagram > svg"), vb=s?.viewBox.baseVal;
return {open:true, win:[innerWidth, innerHeight], panel:[p.left, p.top, p.width, p.height].map(Math.round), id:s?.id, vb:vb && [vb.width, vb.height],
  buttons:[...z.querySelectorAll(".mde-actions-right .embed-action")].map(b=>b.getAttribute("aria-label")), menu:!!z.querySelector(".mde-menu-button"),
  static:!!z.querySelector(".mde-static"), modal:document.querySelectorAll(".modal-container").length}})())"""


def zoom_state():
    return json.loads(js(ZOOM_STATE))


def open_zoom(where='source'):
    """Clicks the map's "Zoom in"; an error text, or None."""
    p = locate(where, z=['zoom-button'])
    if not p.get('z'):
        return f'no zoom button in {where}'
    mouse('mouseMoved', *p['z']); wait(0.2)
    click(*p['z']); wait(1.2)
    return None if zoom_state()['open'] else 'the zoom did not open'


def close_zoom():
    js('(()=>{document.querySelector(".mde-zoom .mde-unzoom-button")?.click(); return "x"})()'); wait(0.4)


def fits(s, margin=8):
    """Inside the window with the image zoom's margin, touching it on the limiting side, the drawing's aspect."""
    W, H = s['win']
    x, y, w, h = s['panel']
    inside = x >= margin - 1 and y >= margin - 1 and x + w <= W - margin + 1 and y + h <= H - margin + 1
    touches = min(abs(x - margin), abs(y - margin)) <= 1.5
    aspect = abs(w / h - s['vb'][0] / s['vb'][1]) < 0.01
    return inside and touches and aspect


def case_zoom_fit():
    """Zoom in fills the window like Obsidian's image zoom (8 px margin on the limiting side, the
    drawing's aspect), also after the window changed size; Zoom out closes it."""
    err = open_zoom()
    if err:
        return False, err
    s1 = zoom_state()
    cdp('Emulation.setDeviceMetricsOverride', {'width': 700, 'height': 900, 'deviceScaleFactor': 0, 'mobile': False}); wait(0.8)
    s2 = zoom_state()
    cdp('Emulation.clearDeviceMetricsOverride', {}); wait(0.8)
    s3 = zoom_state()
    close_zoom()
    closed = not zoom_state()['open']
    ok = all(s['open'] and fits(s) for s in (s1, s2, s3)) and s2['panel'][2] < s1['panel'][2] and closed
    ok = ok and s1['buttons'] == ['Zoom out', 'Edit this block'] and s1['menu'] and not s1['static']
    return ok, f'{s1["panel"]} in {s1["win"]}; resized {s2["panel"]} in {s2["win"]}; back {s3["panel"]}; buttons {s1["buttons"]}; closed {closed}'


def case_zoom_edit_source():
    """The zoom's "Edit this block" (Live Preview) closes it and puts the cursor into the block,
    which then shows its source, as the same button does in the note."""
    err = open_zoom()
    if err:
        return False, err
    b = json.loads(js('JSON.stringify((()=>{const r=document.querySelector(".mde-zoom .mde-source-button")?.getBoundingClientRect(); return r ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null})())'))
    if not b:
        close_zoom()
        return False, 'no "Edit this block" in the zoom'
    click(*b); wait(0.8)
    r = json.loads(js('JSON.stringify((()=>{const e=app.workspace.activeLeaf.view.editor; const t=e.getValue(); const at=e.posToOffset(e.getCursor());'
                      ' const a=t.indexOf("```mermaid"), z=t.indexOf("```", a + 10); return {inBlock: at > a && at < z, zoom: !!document.querySelector(".mde-zoom"), focus: e.hasFocus()}})())'))
    return r == {'inBlock': True, 'zoom': False, 'focus': True}, json.dumps(r)


def case_zoom_drag():
    """A node dragged in the zoom moves in the note's source, and the zoom draws it anew there."""
    err = open_zoom()
    if err:
        return False, err
    before, src = locate('zoom', n=['node', 'Beta'])['n'], line(r'^component Beta .*$')
    id1 = zoom_state()['id']
    drag(*before, 70, 0, 8); wait(1.3)
    after, got, id2 = locate('zoom', n=['node', 'Beta'])['n'], line(r'^component Beta .*$'), zoom_state()['id']
    close_zoom()
    ok = got != src and id2 != id1 and after and abs(after[0] - before[0] - 70) <= 5
    return ok, f'{src} -> {got}; drawn at {before} -> {after}; drawing {id1} -> {id2}'


def case_zoom_touch_drag():
    """A finger drags a component in the zoom as in the note."""
    err = open_zoom()
    if err:
        return False, err
    p, src = locate('zoom', n=['node', 'Beta'])['n'], line(r'^component Beta .*$')
    E.touch('touchStart', *p)
    for i in range(1, 7):
        E.touch('touchMove', p[0], p[1] + 8 * i)
    E.touch('touchEnd', p[0], p[1] + 48); wait(1.3)
    got = line(r'^component Beta .*$')
    close_zoom()
    return got != src, f'{src} -> {got}'


def case_zoom_dialog_escape():
    """A dialog opened in the zoom lies above it; Escape closes the dialog only, the next one the zoom."""
    err = open_zoom()
    if err:
        return False, err
    p = locate('zoom', n=['node', 'Alpha'])['n']
    click(*p, 1); click(*p, 2); wait(0.6)
    title = modal_title()
    on_top = js('(()=>{const m=document.querySelector(".modal"); if(!m) return "none"; const r=m.getBoundingClientRect();'
                ' return String(!!document.elementFromPoint(r.left + r.width / 2, r.top + 12)?.closest(".modal"))})()')
    key('Escape', 'Escape', 27); wait(0.5)
    s1 = zoom_state()
    key('Escape', 'Escape', 27); wait(0.5)
    s2 = zoom_state()
    ok = title.startswith('Edit') and on_top == 'true' and s1['open'] and s1['modal'] == 0 and not s2['open']
    return ok, f'{title!r} on top={on_top}; after Escape open={s1["open"]} modals={s1.get("modal")}; after 2nd Escape open={s2["open"]}'


def case_zoom_legend_escape():
    """The menu works in the zoom; Escape first drops the armed action, the next closes the zoom."""
    err = open_zoom()
    if err:
        return False, err
    p = locate('zoom', m=['menu'])['m']
    mouse('mouseMoved', *p); wait(0.3)
    item = locate('zoom', i=['legend-item', 'evolve'])['i']
    if not item:
        close_zoom()
        return False, 'no legend in the zoom'
    mouse('mouseMoved', p[0], p[1] + 16); mouse('mouseMoved', *item)
    click(*item); wait(0.4)
    armed = js('String(!!document.querySelector(".mde-zoom .mp-legend-item.is-armed"))')
    key('Escape', 'Escape', 27); wait(0.4)
    s1, still = zoom_state(), js('String(!!document.querySelector(".mp-legend-item.is-armed"))')
    key('Escape', 'Escape', 27); wait(0.4)
    s2 = zoom_state()
    ok = armed == 'true' and s1['open'] and still == 'false' and not s2['open']
    return ok, f'armed {armed}; 1st Escape: open {s1["open"]}, armed {still}; 2nd Escape: open {s2["open"]}'


def case_zoom_legend_add():
    """The legend in the zoom adds a component; the zoom shows it."""
    err = open_zoom()
    if err:
        return False, err
    p = locate('zoom', m=['menu'])['m']
    mouse('mouseMoved', *p); wait(0.3)
    item = locate('zoom', i=['legend-item', 'component'])['i']
    mouse('mouseMoved', p[0], p[1] + 16); mouse('mouseMoved', *item)
    click(*item); wait(0.5)
    title = modal_title()
    cdp('Input.insertText', {'text': 'Zoomed'})
    key('Enter', 'Enter', 13); wait(1.3)
    shown = locate('zoom', n=['node', 'Zoomed'])['n']
    close_zoom()
    return title == 'New component' and line(r'^component Zoomed .*$') is not None and shown is not None, f'{title!r}; {line(r"^component Zoomed .*$")}; drawn at {shown}'


def case_zoom_undo():
    """Cmd+Z and Cmd+Y in the zoom undo and redo in the note, and the zoom follows."""
    err = open_zoom()
    if err:
        return False, err
    src = line(r'^component Gamma .*$')
    drag(*locate('zoom', n=['node', 'Gamma'])['n'], 0, 40, 6); wait(1.3)
    moved = line(r'^component Gamma .*$')
    key('z', 'KeyZ', 90, 4); wait(1.2)
    undone, id_u = line(r'^component Gamma .*$'), zoom_state()['id']
    key('y', 'KeyY', 89, 4); wait(1.2)
    redone, id_r = line(r'^component Gamma .*$'), zoom_state()['id']
    close_zoom()
    ok = moved != src and undone == src and redone == moved and id_u != id_r
    return ok, f'{src} -> {moved}; undo {undone}; redo {redone}'


def case_zoom_backdrop():
    """A click on the black margin closes the zoom; a drag released over it does not."""
    err = open_zoom()
    if err:
        return False, err
    s = zoom_state()
    x, y, w, h = s['panel']
    W, H = s['win']
    margin = [max(2, x // 2), H // 2] if x > 12 else [W // 2, max(2, y // 2)]
    n = locate('zoom', n=['node', 'Alpha'])['n']
    src = line(r'^component Alpha .*$')
    E.drag_to(n, margin); wait(1.3)
    after_drag = zoom_state()['open']
    if after_drag:
        js('(app.workspace.activeLeaf.view.editor.undo(), "u")'); wait(1.2)
    click(*margin); wait(0.5)
    closed = not zoom_state()['open']
    ok = after_drag and closed and line(r'^component Alpha .*$') == src
    return ok, f'open after a drag onto the margin: {after_drag}; closed by a click there: {closed}; {line(r"^component Alpha .*$")}'


def case_zoom_group():
    """The group mode works in the zoom: New group, then a click on a component makes the group,
    and the redrawn group in the zoom carries the glow."""
    err = open_zoom()
    if err:
        return False, err
    err = open_group_menu('New group', 'zoom')
    if err:
        close_zoom()
        return False, err
    click(*locate('zoom', n=['node', 'Delta two'])['n']); wait(1.4)
    made = group_line('Group 2') or group_line('Group 1')
    glow = js('String(document.querySelectorAll(".mde-zoom g.mde-group.mp-group-editing").length)')
    key('Escape', 'Escape', 27); wait(0.4)
    key('Escape', 'Escape', 27); wait(0.4)
    closed = not zoom_state()['open']
    if made:
        js('(app.workspace.activeLeaf.view.editor.undo(), "u")'); wait(1)
    return bool(made and 'Delta two' in made) and glow == '1' and closed, f'{made}; glow {glow}; closed {closed}'


def case_zoom_follows():
    """The zoom follows its block through a change made elsewhere (sync, another tab) and closes
    when the block is gone."""
    err = open_zoom()
    if err:
        return False, err
    keep = js('app.workspace.activeLeaf.view.editor.getValue()')
    js('(()=>{const e=app.workspace.activeLeaf.view.editor; const t=e.getValue(); const at=t.indexOf("component Beta "); e.replaceRange("component Outside [0.20, 0.20]\\n", e.offsetToPos(at)); return "x"})()'); wait(1.2)
    shown = locate('zoom', n=['node', 'Outside'])['n']
    js('(()=>{const e=app.workspace.activeLeaf.view.editor; const t=e.getValue(); const a=t.indexOf("```mermaid"), b=t.indexOf("```", a + 10); e.replaceRange("", e.offsetToPos(a), e.offsetToPos(b + 3)); return "x"})()'); wait(1.2)
    closed = not zoom_state()['open']
    js('(()=>{app.workspace.activeLeaf.view.editor.setValue(' + json.dumps(keep) + '); return "x"})()'); wait(1.5)
    if not closed:
        close_zoom()
    return shown is not None and closed, f'outside change drawn at {shown}; closed when the block went: {closed}'


def case_zoom_reading():
    """Reading view: "Zoom in" in a toolbar of its own at the top right (Obsidian has none there),
    the zoom without "Edit this block", and an edit in the zoom written into the file."""
    js('(async()=>{const l=app.workspace.activeLeaf; const s=l.getViewState(); s.state.mode="preview"; await l.setViewState(s); await new Promise(r=>setTimeout(r,1500)); return "ok"})()')
    try:
        js("(()=>{app.workspace.activeLeaf.view.contentEl.querySelector('.markdown-preview-view .mermaid svg')?.scrollIntoView({block:'center'}); return 'x'})()"); wait(0.6)
        err = open_zoom('preview')
        if err:
            return False, err
        s = zoom_state()
        file_line = lambda: next((l for l in js('(async()=>await app.vault.read(app.workspace.activeLeaf.view.file))()').split('\n') if l.startswith('component Alpha ')), None)
        src = file_line()
        drag(*locate('zoom', n=['node', 'Alpha'])['n'], -50, 0, 6); wait(1.6)
        got, s2 = file_line(), zoom_state()
        close_zoom()
        ok = s['buttons'] == ['Zoom out'] and s['menu'] and fits(s) and got != src and s2['id'] != s['id']
        return ok, f'buttons {s["buttons"]}; {src} -> {got}; drawing {s["id"]} -> {s2["id"]}'
    finally:
        js('(async()=>{const l=app.workspace.activeLeaf; const s=l.getViewState(); s.state.mode="source"; s.state.source=false; await l.setViewState(s); await new Promise(r=>setTimeout(r,1500)); return "ok"})()')


def case_component_on_shaft():
    # Review #1: Zeta lies on Gamma's evolve arrow; a click on Zeta must not delete the arrow,
    # and a drag must move Zeta.
    before = line(r'^evolve Gamma .*$')
    p = locate(z=['node', 'Zeta'])
    click(*p['z']); wait(0.8)
    kept = line(r'^evolve Gamma .*$') == before
    js('(()=>{[...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Cancel")?.click(); return "x"})()')
    park(); p = locate(z=['node', 'Zeta'])
    drag(*p['z'], 0, -40); wait()
    moved = line(r'^component Zeta .*$') != 'component Zeta [0.50, 0.28]'
    return kept and moved, f'arrow kept={kept}; {line(r"^component Zeta .*$")}'


def case_swallow_scope():
    # Review #7: for 500 ms after a gesture every mouse event in Obsidian was swallowed. The
    # window is shorter than one scripted CDP round trip, so gesture and probe run in one eval:
    # a synthetic drag of Alpha, then at once a mousedown on a text line outside the map; it is
    # swallowed when it never reaches the line (CodeMirror itself calls preventDefault, so the
    # default-prevented flag proves nothing).
    p = locate(n=['node', 'Alpha'])
    res = js('(()=>{const [x,y]=' + json.dumps(p['n']) + '; const el=document.elementFromPoint(x,y);'
             ' const o=(px,py)=>({clientX:px,clientY:py,pointerId:41,pointerType:"mouse",isPrimary:true,button:0,buttons:1,bubbles:true,cancelable:true,composed:true});'
             ' el.dispatchEvent(new PointerEvent("pointerdown",o(x,y))); el.dispatchEvent(new PointerEvent("pointermove",o(x+12,y+12)));'
             ' el.dispatchEvent(new PointerEvent("pointerup",{...o(x+12,y+12),buttons:0}));'
             ' const line=[...app.workspace.activeLeaf.view.contentEl.querySelectorAll(".markdown-source-view .cm-line")].find(l=>l.textContent.startsWith("Filler line"));'
             ' let reached=false; const mark=()=>{reached=true}; line.addEventListener("mousedown",mark);'
             ' line.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true})); line.removeEventListener("mousedown",mark);'
             ' return JSON.stringify({swallowed: !reached})})()')
    wait()
    swallowed = json.loads(res)['swallowed']
    return swallowed is False, f'text mousedown right after a gesture swallowed={swallowed}'


# Runs entirely inside Obsidian: CDP input reaches only the main window, so the pop-out gets
# DOM pointer events dispatched in its own document (the listeners are what was missing).
POPOUT = r"""
(async()=>{
const sleep = ms => new Promise(r => setTimeout(r, ms));
const main = app.workspace.activeLeaf;
const leaf = app.workspace.openPopoutLeaf({size: {width: 1000, height: 800}});
const out = {};
try {
  await leaf.openFile(main.view.file);
  const st = leaf.getViewState(); st.state.mode = 'source'; st.state.source = false; await leaf.setViewState(st);
  leaf.view.editor.setCursor({line: 0, ch: 0});
  leaf.view.editor.scrollIntoView({from: {line: 84, ch: 0}, to: {line: 84, ch: 0}}, true);
  await sleep(2000);
  const doc = leaf.view.containerEl.ownerDocument, win = doc.defaultView;
  out.popout = doc !== document;
  out.bodyClass = doc.body.classList.contains('mp-wardley-edit');
  const svg = leaf.view.contentEl.querySelector('.markdown-source-view .mermaid svg[aria-roledescription="wardley"]');
  if (!svg) return JSON.stringify({...out, error: 'no map in pop-out'});
  svg.scrollIntoView({block: 'center'}); await sleep(600);
  const g = [...svg.querySelectorAll('g.wardley-node')].find(g => g.querySelector('text.wardley-node-label')?.textContent.trim() === 'Beta');
  const c = [...g.querySelectorAll(':scope > circle')].filter(c => !c.getAttribute('class')).pop();
  const p = svg.createSVGPoint(); p.x = +c.getAttribute('cx'); p.y = +c.getAttribute('cy');
  const s = p.matrixTransform(svg.getScreenCTM());
  const fire = (type, x, y, buttons) => {
    const t = doc.elementFromPoint(x, y) ?? svg;
    t.dispatchEvent(new win.PointerEvent(type, {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons}));
  };
  fire('pointerdown', s.x, s.y, 1);
  for (let i = 1; i <= 5; i++) { fire('pointermove', s.x - 8 * i, s.y + 6 * i, 1); await sleep(30); }
  fire('pointerup', s.x - 40, s.y + 30, 0);
  await sleep(1500);
  out.beta = (leaf.view.editor.getValue().match(/^component Beta .*$/m) || [null])[0];
  return JSON.stringify(out);
} finally { leaf.detach(); app.workspace.setActiveLeaf(main, {focus: true}); await sleep(300); }
})()
"""


def case_popout_window():
    r = json.loads(js(POPOUT))
    ok = r.get('popout') and r.get('bodyClass') and r.get('beta') not in (None, 'component Beta [0.80, 0.80]')
    return ok, json.dumps(r)



# Drawn styles of nodes and links, with the theme's accent colour resolved to rgb() for comparison.
STYLES = r"""
(()=>{
const root = app.workspace.activeLeaf.view.contentEl.querySelector(__ROOT__);
const svg = root && root.querySelector('.mermaid svg[aria-roledescription="wardley"]');
if (!svg) return JSON.stringify({error: 'no map'});
const probe = document.body.createDiv(); probe.style.color = 'var(--color-accent)'; const accent = getComputedStyle(probe).color; probe.remove();
const node = n => [...svg.querySelectorAll('g.wardley-node')].find(g => g.querySelector('text.wardley-node-label')?.textContent.trim() === n);
const shape = g => [...g.querySelectorAll(':scope > circle')].find(c => !c.getAttribute('class')) ?? g.querySelector(':scope > rect');
const centre = n => { const g = node(n); const c = g && shape(g); if (c) return c.localName === 'rect' ? [+c.getAttribute('x') + +c.getAttribute('width') / 2, +c.getAttribute('y') + +c.getAttribute('height') / 2] : [+c.getAttribute('cx'), +c.getAttribute('cy')];
  const t = g?.querySelector('text'); return t ? [+t.getAttribute('x'), +t.getAttribute('y') + 3] : null; };
const near = (x, y, c) => c && Math.hypot(x - c[0], y - c[1]) <= 10;
const out = {accent};
for (const [k, [what, a, b]] of Object.entries(__ARG__)) {
  if (what === 'node') { const g = node(a); out[k] = g && {cls: g.getAttribute('class'), shape: getComputedStyle(shape(g)).stroke, label: getComputedStyle(g.querySelector('text.wardley-node-label')).fill}; }
  else { const ca = centre(a), cb = centre(b);
    const l = [...svg.querySelectorAll('line.wardley-link')].find(l => { const x1 = +l.getAttribute('x1'), y1 = +l.getAttribute('y1'), x2 = +l.getAttribute('x2'), y2 = +l.getAttribute('y2'); return (near(x1, y1, ca) && near(x2, y2, cb)) || (near(x1, y1, cb) && near(x2, y2, ca)); });
    out[k] = l && {cls: l.getAttribute('class'), stroke: getComputedStyle(l).stroke}; }
}
return JSON.stringify(out);
})()
"""


def styles(spec, view='.markdown-source-view'):
    raw = js(STYLES.replace('__ROOT__', json.dumps(view)).replace('__ARG__', json.dumps(spec)))
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f'styles failed: {raw[:200]}')


def save_with_highlight_toggled(at, double):
    """Opens a dialog (double click: element, click: link), flips its Highlight toggle, saves."""
    if double:
        click(*at, 1); click(*at, 2)
    else:
        click(*at)
    wait(0.6)
    title = modal_title()
    js('(()=>{const m=document.querySelector(".modal"); const s=[...m.querySelectorAll(".setting-item")]'
       '.find(s=>s.querySelector(".setting-item-name")?.textContent==="Highlight");'
       ' s.querySelector(".checkbox-container").click();'
       ' [...m.querySelectorAll("button")].find(b=>b.textContent==="Save").click(); return "x"})()')
    wait(); park()
    return title


def case_highlight_dialog():
    """The element dialog's Highlight writes `%% class <name> highlight`, the map draws the component
    in the accent colour (outline and label), its neighbour stays as it was; off removes the line."""
    t1 = save_with_highlight_toggled(locate(n=['node', 'Gamma'])['n'], True)
    on = line(r'^%% class Gamma .*$')
    st = styles({'g': ['node', 'Gamma'], 'z': ['node', 'Zeta']})
    t2 = save_with_highlight_toggled(locate(n=['node', 'Gamma'])['n'], True)
    off = line(r'^%% class Gamma .*$')
    g, z, accent = st.get('g') or {}, st.get('z') or {}, st.get('accent')
    ok = (t1 == t2 == 'Edit "Gamma"' and on == '%% class Gamma highlight' and 'mde-class-highlight' in g.get('cls', '')
          and g.get('shape') == accent and g.get('label') == accent and z.get('shape') != accent and off is None)
    return ok, f'{on}; Gamma {g}; Zeta {z}; accent {accent}; after off: {off}'


def case_highlight_link_dialog():
    """The link dialog's Highlight writes `%% class <from> -> <to> highlight` and the line takes the
    accent colour, in Live Preview and in reading view."""
    title = save_with_highlight_toggled(locate(m=['link-mid', 'User', 'Alpha'])['m'], False)
    got = line(r'^%% class User .*$')
    live = styles({'l': ['link', 'User', 'Alpha']})
    leaf = "app.workspace.activeLeaf"
    js('(async()=>{const l=' + leaf + '; const s=l.getViewState(); s.state.mode="preview"; await l.setViewState(s);'
       ' await new Promise(r=>setTimeout(r,800)); l.view.currentMode.applyScroll(80); await new Promise(r=>setTimeout(r,1500)); return "ok"})()')
    try:
        read = styles({'l': ['link', 'User', 'Alpha']}, '.markdown-preview-view')
    finally:
        js('(async()=>{const l=' + leaf + '; const s=l.getViewState(); s.state.mode="source"; await l.setViewState(s);'
           ' await new Promise(r=>setTimeout(r,1200)); return "ok"})()')
        park()
    ok = (title.startswith('Link') and got == '%% class User -> Alpha highlight'
          and (live.get('l') or {}).get('stroke') == live.get('accent') and (read.get('l') or {}).get('stroke') == read.get('accent'))
    return ok, f'{got}; live {live}; reading view {read}'



# The groups of the map: per group its boundary's stroke, dashes and pointer events, its label, and
# which points lie inside it (SVGGeometryElement.isPointInFill, in the map's own units); the map's
# line colour (a link without a class: an earlier case highlights one), the accent and the theme's
# purple to compare with.
GROUP_PROBE = r"""
(()=>{
const root = app.workspace.activeLeaf.view.contentEl.querySelector(__ROOT__);
const svg = root && root.querySelector('.mermaid svg[aria-roledescription="wardley"]');
const groups = svg ? [...svg.querySelectorAll('g.mde-group')] : [];
if (!groups.length) return JSON.stringify({error: svg ? 'no boundary' : 'no map'});
const colour = v => { const d = document.body.createDiv(); d.style.color = v; const c = getComputedStyle(d).color; d.remove(); return c; };
const centre = n => { const g = [...svg.querySelectorAll('g.wardley-node')].find(g => g.querySelector('text.wardley-node-label')?.textContent.trim() === n);
  const c = g && [...g.querySelectorAll(':scope > circle')].find(c => !c.getAttribute('class')); return c && new DOMPoint(+c.getAttribute('cx'), +c.getAttribute('cy')); };
const out = {accent: colour('var(--color-accent)'), purple: colour('var(--color-purple)'), ink: getComputedStyle(svg.querySelector('line.wardley-link:not(.mde-class)')).stroke};
for (const g of groups) {
  const path = g.querySelector('path.mde-group-boundary'), label = g.querySelector('text.mde-group-label');
  const cs = getComputedStyle(path), r = label && label.getBoundingClientRect();
  const inside = (n, dy = 0) => { const p = centre(n); return p ? path.isPointInFill(new DOMPoint(p.x, p.y + dy)) : null; };
  out[label ? label.textContent : '#' + g.getAttribute('data-mde-group')] = {stroke: cs.stroke, dash: cs.strokeDasharray, events: cs.pointerEvents, label: label && getComputedStyle(label).fill,
    at: r && [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)],
    beta: inside('Beta'), omega: inside('Omega'), alpha: inside('Alpha'), above22: inside('Alpha', -22)};
}
return JSON.stringify(out);
})()
"""


def group_probe(view):
    raw = js(GROUP_PROBE.replace('__ROOT__', json.dumps(view)))
    return json.loads(raw)


def in_reading_view(f):
    """Runs f in reading view, then back to Live Preview with the map in view."""
    leaf = "app.workspace.activeLeaf"
    js('(async()=>{const l=' + leaf + '; const s=l.getViewState(); s.state.mode="preview"; await l.setViewState(s);'
       ' await new Promise(r=>setTimeout(r,800)); l.view.currentMode.applyScroll(80); await new Promise(r=>setTimeout(r,1500)); return "ok"})()')
    try:
        return f()
    finally:
        js('(async()=>{const l=' + leaf + '; const s=l.getViewState(); s.state.mode="source"; await l.setViewState(s);'
           ' await new Promise(r=>setTimeout(r,1200)); return "ok"})()')
        park()


def case_group_render():
    """`%% group "E2E Group" Beta, Epsilon` is drawn as a dashed boundary in the map's own line colour,
    labelled, holding both members and nothing far away, taking no pointer events; `Team`, styled by
    `classDef team stroke:purple, r:24`, is drawn in the theme's purple with radius 24. In Live Preview
    and in reading view; the rename of Epsilon (case rename_dialog) has rewritten the group line."""
    got = line(r'^%% group "E2E.*$')
    live = group_probe('.markdown-source-view')
    read = in_reading_view(lambda: group_probe('.markdown-preview-view'))
    def ok_view(v):
        g, t = v.get('E2E Group') or {}, v.get('Team') or {}
        return (g.get('stroke') == v.get('ink') != v.get('accent') and g.get('label') == v.get('ink') and g.get('dash') not in (None, '', 'none')
                and g.get('events') == 'none' and g.get('beta') is True and g.get('omega') is True and g.get('alpha') is False
                and t.get('stroke') == v.get('purple') and t.get('label') == v.get('purple') and t.get('above22') is True)
    ok = got == '%% group "E2E Group" label Beta, Omega' and ok_view(live) and ok_view(read)
    return ok, f'{got}; live {live}; reading view {read}'


def case_group_highlight():
    """`%% class "E2E Group" highlight` draws that group's boundary and label in the accent colour;
    `Team` keeps its own colour."""
    js('(()=>{const e=app.workspace.activeLeaf.view.editor; const n=e.getValue().split("\\n").findIndex(l=>l.startsWith(\'%% group "E2E\'));'
       ' e.replaceRange(\'%% class "E2E Group" highlight\\n\', {line:n+1, ch:0}); return "x"})()')
    wait(1.5); park()
    v = group_probe('.markdown-source-view')
    g, t = v.get('E2E Group') or {}, v.get('Team') or {}
    ok = g.get('stroke') == v.get('accent') and g.get('label') == v.get('accent') and t.get('stroke') == v.get('purple')
    return ok, f'{line(r"^%% class .E2E.*$")}; {v}'


def case_group_label_drag():
    """Dragging a group's label writes `label [dx, dy]` after the group's name, and the label is
    drawn where it was dropped."""
    p = locate(l=['group-label', 'E2E Group'])
    drag(*p['l'], 40, -20); wait(); park()
    got = line(r'^%% group "E2E.*$')
    m = re.search(r'label \[(-?\d+), (-?\d+)\]', got or '')
    before = group_probe('.markdown-source-view')
    # A second drag adds to the offset rather than replacing it.
    p2 = locate(l=['group-label', 'E2E Group'])
    drag(*p2['l'], -20, 0); wait(); park()
    again = re.search(r'label \[(-?\d+), (-?\d+)\]', line(r'^%% group "E2E.*$') or '')
    ok = bool(m and int(m.group(1)) > 0 and int(m.group(2)) < 0 and got.endswith('Beta, Omega')
              and again and int(again.group(1)) < int(m.group(1)) and again.group(2) == m.group(2))
    return ok, f'{got}; then {again and again.group(0)}; label at {(before.get("E2E Group") or {}).get("at")}'


# The group mode as the page shows it: which groups are marked, the mode's notice, the labels drawn.
GROUP_STATE = r"""
(()=>{
const root = app.workspace.activeLeaf.view.contentEl.querySelector('.markdown-source-view');
const svg = root && root.querySelector('.mermaid svg[aria-roledescription="wardley"]');
const editing = svg ? [...svg.querySelectorAll('g.mde-group.mp-group-editing')].map(g => +g.getAttribute('data-mde-group')) : [];
const notice = document.querySelector('.notice .mp-group-notice')?.textContent ?? null;
const labels = svg ? [...svg.querySelectorAll('text.mde-group-label')].map(t => t.textContent) : [];
return JSON.stringify({editing, notice, labels});
})()
"""


def group_state():
    return json.loads(js(GROUP_STATE))


def group_line(name):
    return line(r'^%% group "?' + re.escape(name) + r'"? .*$')


def open_group_menu(title, where='source'):
    """The legend's "Group", then `title` in its menu; an error text, or None."""
    p = locate(where, c=['menu'])
    mouse('mouseMoved', *p['c']); wait(0.3)
    item = locate(where, i=['legend-item', 'group'])['i']
    if not item:
        return 'legend not shown'
    click(*item); wait(0.6)
    m = locate(m=['menu-item', title]).get('m')
    if not m:
        return f'no menu item {title!r} (native menus on?)'
    click(*m); wait(0.6)
    return None


def escape():
    key('Escape', 'Escape', 27); wait(1)


def case_group_new_from_legend():
    """The legend's Group, then New group: the first component clicked makes "Group 1" (no label), a
    second joins it; the group is marked while it is edited, and Escape ends the mode."""
    err = open_group_menu('New group')
    if err:
        return False, err
    s0 = group_state()
    click(*locate(n=['node', 'Gamma'])['n']); wait()
    first = group_line('Group 1')
    click(*locate(n=['node', 'Zeta'])['n']); wait()
    second = group_line('Group 1')
    s1 = group_state()
    escape()
    s2 = group_state()
    ok = ('New group' in (s0['notice'] or '') and first == '%% group "Group 1" Gamma' and second == '%% group "Group 1" Gamma, Zeta'
          and len(s1['editing']) == 1 and 'Group 1' in (s1['notice'] or '') and 'Group 1' not in s1['labels']
          and s2['editing'] == [] and s2['notice'] is None)
    return ok, f'{first}; {second}; while editing {s1}; after Escape {s2}'


def case_group_members():
    """A group chosen in the legend's menu: a click takes a member out, the next puts it back; taking
    the last member out deletes the group and ends the mode."""
    err = open_group_menu('Group 1')
    if err:
        return False, err
    zeta = lambda: locate(n=['node', 'Zeta'])['n']
    click(*zeta()); wait()
    out = group_line('Group 1')
    click(*zeta()); wait()
    back = group_line('Group 1')
    click(*zeta()); wait()
    click(*locate(n=['node', 'Gamma'])['n']); wait()
    gone = group_line('Group 1')
    s = group_state()
    if s['notice'] is not None:
        escape()
    ok = out == '%% group "Group 1" Gamma' and back == '%% group "Group 1" Gamma, Zeta' and gone is None and s['editing'] == [] and s['notice'] is None
    return ok, f'out: {out}; back: {back}; last out: {gone}; {s}'


def case_group_touch_tap():
    """In the group mode a finger's tap puts a component in, as a click does; Done in the mode's
    notice ends it."""
    err = open_group_menu('Team')
    if err:
        return False, err
    tap(*locate(n=['node', 'Gamma'])['n']); wait()
    got = group_line('Team')
    done = locate(b=['notice-button', 'Done'])['b']
    if done:
        click(*done); wait(1)
    s = group_state()
    if s['notice'] is not None:
        escape()
    return got == '%% group Team label Alpha, Beta, Gamma' and bool(done) and s['notice'] is None and s['editing'] == [], f'{got}; Done {done}; {s}'


def case_group_properties_delete():
    """"Properties…" in the mode's notice opens the group's dialog; Delete (two clicks) removes the
    group and the class lines naming it; its components and the classDef stay."""
    err = open_group_menu('Team')
    if err:
        return False, err
    b = locate(b=['notice-button', 'Properties…'])['b']
    if not b:
        escape()
        return False, 'no Properties button'
    click(*b); wait(0.6)
    title = modal_title()
    modal('btn("Delete").click()')
    modal('btn("Really delete? Its components stay.").click()')
    wait()
    src = source()
    ok = (title == 'Edit group "Team"' and group_line('Team') is None and '%% class Team team' not in src
          and 'component Gamma' in src and '%% classDef team' in src and group_state()['notice'] is None)
    return ok, f'{title!r}; Team line: {group_line("Team")}; class lines: {[l for l in src.splitlines() if l.startswith("%% class")]}'


def case_group_label_dialog():
    """A click on a group's label starts its group mode, a double click opens its dialog: a new name,
    another class and the label hidden are written as one edit, and the class line follows."""
    click(*locate(l=['group-label', 'E2E Group'])['l']); wait(0.8)
    s = group_state()
    dblclick(*locate(l=['group-label', 'E2E Group'])['l']); wait(0.6)
    title = modal_title()
    modal('const t=m.querySelector("input[type=text]"); set(t,"Renamed Group"); set(sels[0],"team"); set(sels[1],"off"); btn("Save").click()')
    wait()
    src = source()
    g = group_line('Renamed Group')
    cls = [l for l in src.splitlines() if l.startswith('%% class ') and ('Renamed' in l or 'E2E' in l)]
    ok = (len(s['editing']) == 1 and title == 'Edit group "E2E Group"' and g == '%% group "Renamed Group" Beta, Omega'
          and len(cls) == 1 and re.match(r'^%% class "?Renamed Group"? team$', cls[0]) and group_state()['notice'] is None)
    return bool(ok), f'mode {s}; {title!r}; {g}; {cls}'


def group_index(name):
    """The index the drawing gives a group: its place among the map's group names."""
    names = []
    for l in source().splitlines():
        m = re.match(r'^%% group (?:"([^"]*)"|\'([^\']*)\'|(\S+))', l)
        n = m and (m.group(1) or m.group(2) or m.group(3))
        if n and n not in names:
            names.append(n)
    return names.index(name)


def case_group_area_click():
    """A click on free space inside a group (here one without a label) starts its group mode, a double
    click there opens its dialog; what is drawn inside keeps its own clicks (the other cases)."""
    idx = group_index('Renamed Group')
    p = locate(f=['group-free', idx]).get('f')
    if not p:
        return False, 'no free point inside the group'
    click(*p); wait(0.8)
    s = group_state()
    dblclick(*p); wait(0.6)
    title = modal_title()
    E.close_modals(); wait(1)
    after = group_state()
    ok = s['editing'] == [idx] and 'Renamed Group' in (s['notice'] or '') and title == 'Edit group "Renamed Group"' and after['notice'] is None
    return ok, f'at {p}: {s}; {title!r}; after {after}'


def case_unload_cleanup():
    # Review #6: unload leaves no stub, legend, drop highlight or open dialog behind; since 0.24.0
    # no button, no zoom either (one is left open on purpose here).
    p = locate(s=['plus', 'Gamma'], c=['menu'])
    click(*p['s']); wait(0.3)
    mouse('mouseMoved', *p['c']); wait(0.3)
    before = js('JSON.stringify({stub:document.querySelectorAll("line.mp-new-link").length, legend:document.querySelectorAll(".mp-legend").length})')
    open_zoom()
    count = '{stub:document.querySelectorAll("line.mp-new-link").length, legend:document.querySelectorAll(".mp-legend").length, host:document.querySelectorAll(".mde-host").length, buttons:document.querySelectorAll(".mde-actions, .mde-zoom-button").length, zoom:document.querySelectorAll(".mde-zoom").length}'
    after = js('(async()=>{await app.plugins.disablePlugin(' + json.dumps(PLUGIN_ID) + '); const r=' + count + '; await app.plugins.enablePlugin(' + json.dumps(PLUGIN_ID) + '); await new Promise(r=>setTimeout(r,1500)); return JSON.stringify(r)})()')
    a = json.loads(after)
    return json.loads(before)['stub'] == 1 and a == {'stub': 0, 'legend': 0, 'host': 0, 'buttons': 0, 'zoom': 0}, f'before {before}; after unload {after}'


CASES = [
    ('node_drag', case_node_drag), ('undo', case_undo), ('label_drag', case_label_drag),
    ('evolve_tip', case_evolve_tip), ('inertia_drag', case_inertia_drag), ('evolve_delete', case_evolve_delete),
    ('relink', case_relink), ('link_dialog', case_link_dialog), ('new_link_stub', case_new_link_stub),
    ('new_component_drop', case_new_component_drop), ('click_click_link', case_click_click_link),
    # Before the annotation cases: the dragged annotations box later lies over Delta.
    ('dialog_saves_all', case_dialog_saves_all),
    ('note_drag', case_note_drag), ('force_drag', case_force_drag), ('pipeline_box_drag', case_pipeline_box_drag),
    ('annotation_drag', case_annotation_drag), ('annotations_box_drag', case_annotations_box_drag),
    ('annotation_dialog', case_annotation_dialog), ('annotation_delete', case_annotation_delete),
    ('legend_annotation', case_legend_annotation),
    ('rename_dialog', case_rename_dialog), ('type_dialog', case_type_dialog), ('buttons', case_buttons), ('legend_menu', case_legend_menu), ('menu_tap', case_menu_tap),
    ('highlight_dialog', case_highlight_dialog), ('highlight_link_dialog', case_highlight_link_dialog),
    ('group_render', case_group_render), ('group_highlight', case_group_highlight), ('group_label_drag', case_group_label_drag),
    ('group_new_from_legend', case_group_new_from_legend), ('group_members', case_group_members), ('group_touch_tap', case_group_touch_tap),
    ('group_properties_delete', case_group_properties_delete), ('group_label_dialog', case_group_label_dialog),
    ('group_area_click', case_group_area_click),
    ('component_on_shaft', case_component_on_shaft), ('swallow_scope', case_swallow_scope),
    ('zoom_fit', case_zoom_fit), ('zoom_edit_source', case_zoom_edit_source), ('zoom_drag', case_zoom_drag), ('zoom_touch_drag', case_zoom_touch_drag),
    ('zoom_dialog_escape', case_zoom_dialog_escape), ('zoom_legend_escape', case_zoom_legend_escape), ('zoom_legend_add', case_zoom_legend_add),
    ('zoom_undo', case_zoom_undo), ('zoom_backdrop', case_zoom_backdrop), ('zoom_group', case_zoom_group),
    ('zoom_follows', case_zoom_follows), ('zoom_reading', case_zoom_reading),
    ('popout_window', case_popout_window),
    ('unload_cleanup', case_unload_cleanup),
]


if __name__ == '__main__':
    # The legend's Group menu is a native macOS menu when that setting is on, and not in the page.
    E.run(CASES, SCRATCH, park, config={'nativeMenus': False})
