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
import json
import os
import re
import subprocess
import sys
import time

NOTE = f'Mermaid Direct Edit E2E {time.strftime("%Y%m%d-%H%M%S")}.md'
# The Obsidian CLI. `obs` is a wrapper that keeps stdin open (plain `obsidian` drops slow,
# asynchronous answers when stdin is closed) and returns real exit codes.
CLI = os.environ.get('OBSIDIAN_CLI', 'obs')
PLUGIN_ID = 'mermaid-direct-edit'
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
"""
FILLER = '\n\n'.join(f'Filler line {i} so the map sits below the top.' for i in range(1, 41))


def obs(*args, timeout=60):
    r = subprocess.run([CLI, *args], capture_output=True, text=True, timeout=timeout)
    out = r.stdout.strip()
    return out[3:] if out.startswith('=> ') else out


def js(code):
    return obs('eval', f'code={code}')


def cdp(method, params):
    obs('dev:cdp', f'method={method}', f'params={json.dumps(params)}')


def mouse(kind, x, y, buttons=0, count=1):
    p = {'type': kind, 'x': x, 'y': y}
    if kind != 'mouseMoved' or buttons:
        p.update(button='left', buttons=buttons, clickCount=count)
    cdp('Input.dispatchMouseEvent', p)


def click(x, y, count=1):
    mouse('mouseMoved', x, y)
    mouse('mousePressed', x, y, 1, count)
    mouse('mouseReleased', x, y, 0, count)


def drag(x, y, dx, dy, steps=5):
    mouse('mouseMoved', x, y)
    mouse('mousePressed', x, y, 1)
    for i in range(1, steps + 1):
        mouse('mouseMoved', round(x + dx * i / steps), round(y + dy * i / steps), 1)
    mouse('mouseReleased', round(x + dx), round(y + dy), 0)


def key(k, code, vk, modifiers=0, commands=None):
    p = {'type': 'keyDown', 'key': k, 'code': code, 'windowsVirtualKeyCode': vk, 'modifiers': modifiers}
    if commands:
        p['commands'] = commands
    cdp('Input.dispatchKeyEvent', p)


# Locators run inside Obsidian and answer screen coordinates of rendered parts.
LOCATE = r"""
(async()=>{
const root = app.workspace.activeLeaf.view.contentEl.querySelector('.markdown-source-view');
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
  else if (what === 'legend-item') { const i = svg.closest('.mermaid').querySelector(`.mp-wardley-legend [data-mp-add="${a}"]`); out[k] = i && mid(i.getBoundingClientRect()); }
  else if (what === 'plus') { const c = center(a); const s = scr(...c); out[k] = [s[0], s[1] + 15]; }
  else if (what === 'scroll') { out[k] = Math.round(root.querySelector('.cm-scroller').scrollTop); }
}
return JSON.stringify(out);
})()
"""


def locate(**spec):
    raw = js(LOCATE.replace('__ARG__', json.dumps(spec)))
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


def modal_title():
    return js('document.querySelector(".modal-title")?.textContent ?? ""')


def park():
    """Cursor to line 0 and the map into view, as a user would have it."""
    js("(async()=>{const l=app.workspace.activeLeaf; l.view.editor.setCursor({line:0,ch:0});"
       "l.view.editor.scrollIntoView({from:{line:84,ch:0},to:{line:84,ch:0}},true); await new Promise(r=>setTimeout(r,900));"
       "l.view.contentEl.querySelector('.markdown-source-view .mermaid svg')?.scrollIntoView({block:'center'});"
       "await new Promise(r=>setTimeout(r,600)); return 'ok'})()")


def setup():
    content = ('E2E scratch note for mermaid-direct-edit (scripts/e2e-wardley.py), deleted after the run.\n\n'
               + FILLER + '\n\n```mermaid\n' + MAP + '```\n\n' + FILLER + '\n')
    js("(async()=>{const p=" + json.dumps(NOTE) + "; if(app.vault.getAbstractFileByPath(p)) return 'exists';"
       " const f=await app.vault.create(p," + json.dumps(content) + "); await app.workspace.getLeaf('tab').openFile(f);"
       " const l=app.workspace.activeLeaf; const s=l.getViewState(); s.state.mode='source'; s.state.source=false; await l.setViewState(s);"
       " await new Promise(r=>setTimeout(r,1500)); return 'ok'})()")
    park()


def on_scratch_note():
    return js("app.workspace.activeLeaf?.view?.file?.path ?? ''") == NOTE


def teardown():
    # A case that unloads the plugin must never leave it unloaded (0.14.0 re-enabled the old id).
    js('(async()=>{const id=' + json.dumps(PLUGIN_ID) + '; if(!app.plugins.plugins[id]) await app.plugins.enablePlugin(id); return "ok"})()')
    js("(async()=>{const p=" + json.dumps(NOTE) + "; const ls=[]; app.workspace.iterateAllLeaves(l=>{if(l.view?.file?.path===p) ls.push(l)});"
       " ls.forEach(l=>l.detach()); const f=app.vault.getAbstractFileByPath(p); if(f) await app.fileManager.trashFile(f); return 'ok'})()")


def wait(s=1.3):
    time.sleep(s)


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
    p = locate(c=['corner', 'right'])
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
       ' [...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Rename").click(); return "x"})()')
    wait()
    return title.startswith('Edit') and line(r'^component Omega .*$') is not None and 'Epsilon' not in source(), title


def case_type_dialog():
    """The node dialog's Type dropdown writes the sourcing decorator, Mermaid draws its ring, Default removes it."""
    def pick(value):
        p = locate(n=['node', 'Alpha'])
        click(*p['n'], 1); click(*p['n'], 2); wait(0.6)
        shown = js('(()=>{const s=document.querySelector(".modal select"); if(!s) return "none"; const v=s.value;'
                   ' s.value=' + json.dumps(value) + '; s.dispatchEvent(new Event("change")); return v})()')
        wait(); park()
        ring = js('String(!!app.workspace.activeLeaf.view.contentEl.querySelector(".mermaid svg .wardley-buy-overlay"))')
        return shown, line(r'^component Alpha .*$'), ring
    shown1, got1, ring1 = pick('buy')
    shown2, got2, ring2 = pick('default')
    ok = (shown1 == 'default' and got1 == 'component Alpha [0.80, 0.30] (buy)' and ring1 == 'true'
          and shown2 == 'buy' and got2 == 'component Alpha [0.80, 0.30]' and ring2 == 'false')
    return ok, f'{shown1} -> {got1} ring={ring1}; {shown2} -> {got2} ring={ring2}'


def case_legend_corner():
    p = locate(c=['corner', 'left'])
    mouse('mouseMoved', *p['c']); wait(0.3)
    item = locate(i=['legend-item', 'note'])['i']
    if not item:
        return False, 'legend not shown'
    # Every icon keeps its 24x16, also with full-width diagrams on (0.17.1: they were stretched).
    icons = js("JSON.stringify([...new Set([...app.workspace.activeLeaf.view.contentEl.querySelectorAll('.mp-wardley-legend svg')]"
               ".map(s=>{const r=s.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height)}))])")
    if icons != '["24x16"]':
        return False, f'legend icons {icons}'
    click(*item); wait(0.5)
    title = modal_title()
    cdp('Input.insertText', {'text': 'Added note'})
    key('Enter', 'Enter', 13); wait()
    return title == 'New note' and line(r'^note "Added note" .*$') is not None, title


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


def case_unload_cleanup():
    # Review #6: unload leaves no stub, legend, drop highlight or open dialog behind.
    p = locate(s=['plus', 'Gamma'], c=['corner', 'left'])
    click(*p['s']); wait(0.3)
    mouse('mouseMoved', *p['c']); wait(0.3)
    before = js('JSON.stringify({stub:document.querySelectorAll("line.mp-new-link").length, legend:document.querySelectorAll(".mp-wardley-legend").length})')
    after = js('(async()=>{await app.plugins.disablePlugin(' + json.dumps(PLUGIN_ID) + '); const r={stub:document.querySelectorAll("line.mp-new-link").length, legend:document.querySelectorAll(".mp-wardley-legend").length, host:document.querySelectorAll(".mp-wardley-host").length}; await app.plugins.enablePlugin(' + json.dumps(PLUGIN_ID) + '); await new Promise(r=>setTimeout(r,1500)); return JSON.stringify(r)})()')
    a = json.loads(after)
    return json.loads(before)['stub'] == 1 and a == {'stub': 0, 'legend': 0, 'host': 0}, f'before {before}; after unload {after}'


CASES = [
    ('node_drag', case_node_drag), ('undo', case_undo), ('label_drag', case_label_drag),
    ('evolve_tip', case_evolve_tip), ('inertia_drag', case_inertia_drag), ('evolve_delete', case_evolve_delete),
    ('relink', case_relink), ('link_dialog', case_link_dialog), ('new_link_stub', case_new_link_stub),
    ('note_drag', case_note_drag), ('force_drag', case_force_drag), ('pipeline_box_drag', case_pipeline_box_drag),
    ('annotation_drag', case_annotation_drag), ('annotations_box_drag', case_annotations_box_drag),
    ('annotation_dialog', case_annotation_dialog), ('annotation_delete', case_annotation_delete),
    ('legend_annotation', case_legend_annotation),
    ('rename_dialog', case_rename_dialog), ('type_dialog', case_type_dialog), ('legend_corner', case_legend_corner),
    ('component_on_shaft', case_component_on_shaft), ('swallow_scope', case_swallow_scope),
    ('popout_window', case_popout_window),
    ('unload_cleanup', case_unload_cleanup),
]


def main():
    sel = sys.argv[1] if len(sys.argv) > 1 else ''
    setup()
    failed = 0
    try:
        for name, fn in CASES:
            if sel not in name:
                continue
            if not on_scratch_note():
                print(f'ABORT {name:18} the active note is not the scratch note, stopping before input lands elsewhere')
                failed += 1
                break
            park()
            try:
                ok, detail = fn()
            except Exception as e:  # a crashed case is a failed case
                ok, detail = False, f'{type(e).__name__}: {e}'
            print(f'{"PASS" if ok else "FAIL"}  {name:18} {detail}')
            failed += 0 if ok else 1
            js('(()=>{document.querySelectorAll(".modal-container").length && [...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Cancel")?.click(); return "x"})()')
    finally:
        teardown()
    print(f'{"OK" if failed == 0 else "FAILED"}: {failed} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
