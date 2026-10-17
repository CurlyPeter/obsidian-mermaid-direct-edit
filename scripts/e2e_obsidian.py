"""
Shared driver for the E2E suites (e2e-wardley.py, e2e-flowchart.py): talks to the running
Obsidian through its CLI (`obs`, or OBSIDIAN_CLI), sends real input through the Chrome DevTools
Protocol (`obs dev:cdp`), and owns the scratch note each suite works on.

Loaded by path from the suites (they run with `python3 -I`, which keeps the script's own folder
off the import path):

    spec = importlib.util.spec_from_file_location('e2e_obsidian', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e_obsidian.py'))
"""
import json
import os
import subprocess
import sys
import time

# The Obsidian CLI. `obs` is a wrapper that keeps stdin open (plain `obsidian` drops slow,
# asynchronous answers when stdin is closed) and returns real exit codes.
CLI = os.environ.get('OBSIDIAN_CLI', 'obs')
PLUGIN_ID = 'mermaid-direct-edit'
# The platform's command modifier for CDP key events: Cmd (Meta, 4) on macOS, Ctrl (2) elsewhere.
# The suites run on the machine Obsidian runs on.
MOD = 4 if sys.platform == 'darwin' else 2


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


def dblclick(x, y):
    click(x, y, 1)
    click(x, y, 2)


def drag(x, y, dx, dy, steps=5):
    mouse('mouseMoved', x, y)
    mouse('mousePressed', x, y, 1)
    for i in range(1, steps + 1):
        mouse('mouseMoved', round(x + dx * i / steps), round(y + dy * i / steps), 1)
    mouse('mouseReleased', round(x + dx), round(y + dy), 0)


def drag_to(a, b, steps=6):
    drag(a[0], a[1], b[0] - a[0], b[1] - a[1], steps)


def touch(kind, x, y):
    points = [] if kind == 'touchEnd' else [{'x': x, 'y': y}]
    cdp('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': points})


def tap(x, y):
    touch('touchStart', x, y)
    touch('touchEnd', x, y)


def key(k, code, vk, modifiers=0, commands=None):
    p = {'type': 'keyDown', 'key': k, 'code': code, 'windowsVirtualKeyCode': vk, 'modifiers': modifiers}
    if commands:
        p['commands'] = commands
    cdp('Input.dispatchKeyEvent', p)


def type_text(text):
    cdp('Input.insertText', {'text': text})


def enter():
    key('Enter', 'Enter', 13)


def undo():
    js('(app.workspace.activeLeaf.view.editor.focus(),"f")')
    key('z', 'KeyZ', 90, MOD, ['undo'])


def modal_title():
    return js('document.querySelector(".modal-title")?.textContent ?? ""')


def modal(code):
    """Runs `code` with `m` bound to the open modal's content element (fill fields, click buttons)."""
    # Obsidian 1.14 puts a hidden `select.is-measuring` after each dropdown: `sels` skips them.
    return js('(()=>{const m=document.querySelector(".modal"); if(!m) return "no modal";'
              ' const set=(i,v)=>{i.value=v; i.dispatchEvent(new Event(i.tagName==="SELECT"?"change":"input"));};'
              ' const btn=t=>[...m.querySelectorAll("button")].find(b=>b.textContent===t);'
              ' const sels=[...m.querySelectorAll("select:not(.is-measuring)")];'
              f' {code}; return "ok"}})()')


def close_modals():
    """Cancels an open dialog and closes a zoom a case left open (it would take every later case's input)."""
    js('(()=>{document.querySelectorAll(".modal-container").length && [...document.querySelectorAll(".modal button")].find(b=>b.textContent==="Cancel")?.click();'
       ' document.querySelector(".mde-zoom .mde-unzoom-button")?.click(); return "x"})()')


def wait(s=1.3):
    time.sleep(s)


def cli(action, **flags):
    """A plugin CLI command (`mermaid-direct-edit:<action>`), its answer as a dict ({ok, data|error})."""
    raw = obs(f'{PLUGIN_ID}:{action}', *[f'{k}={v}' for k, v in flags.items()], timeout=120)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {'ok': False, 'error': {'code': 'no-json', 'message': raw[:300]}}


def vault_dir():
    """The test vault on disk (the suites run on the machine Obsidian runs on)."""
    return js('app.vault.adapter.basePath')


def trash_path(path):
    """Moves a vault file or folder to the trash, if it exists."""
    js('(async()=>{const f=app.vault.getAbstractFileByPath(' + json.dumps(path) + '); if(f) await app.fileManager.trashFile(f); return "ok"})()')


def png_facts(data):
    """Width, height and the text chunks of a PNG, read here without the plugin's code (stdlib only)."""
    import struct
    import zlib
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    w, h = struct.unpack('>II', data[16:24])
    texts, crc_ok, at = {}, True, 8
    while at + 12 <= len(data):
        n = struct.unpack('>I', data[at:at + 4])[0]
        kind, body = data[at + 4:at + 8], data[at + 8:at + 8 + n]
        crc_ok = crc_ok and struct.unpack('>I', data[at + 8 + n:at + 12 + n])[0] == zlib.crc32(kind + body)
        if kind == b'tEXt' and b'\0' in body:
            k, v = body.split(b'\0', 1)
            texts[k.decode('latin-1')] = v.decode('latin-1')
        at += 12 + n
        if kind == b'IEND':
            break
    return {'width': w, 'height': h, 'texts': texts, 'crc_ok': crc_ok}


def rsvg_size(path):
    """
    The size librsvg (no browser, no foreignObject) renders the SVG at `path` to, as (width, height);
    False when it fails, None when it is not installed. To stdout: it refuses /dev/null as a file.
    """
    import shutil
    if not shutil.which('rsvg-convert'):
        return None
    r = subprocess.run(['rsvg-convert', path], capture_output=True, timeout=60)
    facts = png_facts(r.stdout) if r.returncode == 0 and not r.stderr.strip() else None
    return (facts['width'], facts['height']) if facts else False


# The export's labels (`withExportConfig` in export-format.ts): drawn with them, the editor's
# drawing has the same elements as the file.
EXPORT_INIT = '%%{init: ' + json.dumps({'htmlLabels': False, 'flowchart': {'htmlLabels': False}, 'fontFamily': 'Helvetica, Arial, sans-serif'}, separators=(',', ':')) + '}%%'
# What a viewer paints: compared per element.
PAINT = ['stroke', 'fill', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'fill-opacity', 'opacity', 'visibility', 'display']


def export_differences(source, svg_path):
    """
    Where the exported SVG at `svg_path` (vault path) paints an element differently than Obsidian
    paints the same diagram. `source` is drawn off screen under `.theme-light .mermaid`, so
    Obsidian's and the plugin's CSS apply; the file is loaded into an empty iframe, where none
    does. Both drawings' shapes, groups and text spans are compared in document order. Answers
    {'count', 'diffs', 'shapes'} or {'error'}.
    """
    code = ('(async()=>{const src=' + json.dumps(source + '\n' + EXPORT_INIT) + ', props=' + json.dumps(PAINT) + ';'
            'const sel="g,path,line,circle,rect,text,tspan,polygon,polyline,ellipse", id="mde-export-e2e"+Date.now();'
            'const host=document.body.createDiv({cls:"theme-light"}); host.style.cssText="position:fixed;left:-100000px;top:0;width:1400px;pointer-events:none";'
            'const box=host.createDiv({cls:"mermaid"}); const ifr=document.createElement("iframe"); ifr.style.cssText="position:fixed;left:-100000px;top:0;width:1400px;height:1000px";'
            'try{const {svg}=await window.mermaid.render(id, src, box); box.insertAdjacentHTML("afterbegin", svg);'
            'const live=box.querySelector(":scope > svg"); const text=await app.vault.adapter.read(' + json.dumps(svg_path) + ');'
            'await new Promise(r=>{ifr.onload=r; ifr.srcdoc="<!doctype html><html><body style=\\"margin:0\\">"+text.slice(text.indexOf("<svg"))+"</body></html>"; document.body.appendChild(ifr);});'
            'const file=ifr.contentDocument.querySelector("svg"); const a=[...live.querySelectorAll(sel)];'
            'const b=[...file.querySelectorAll(sel)].filter(e=>e.getAttribute("class")!=="mde-export-ground");'
            'if(a.length!==b.length) return JSON.stringify({error:"shapes "+a.length+" in Obsidian, "+b.length+" in the file"});'
            'const diffs=[]; for(let i=0;i<a.length;i++){const ca=getComputedStyle(a[i]), cb=ifr.contentWindow.getComputedStyle(b[i]);'
            'for(const p of props){const x=ca.getPropertyValue(p), y=cb.getPropertyValue(p); if(x!==y) diffs.push(b[i].localName+"."+(b[i].getAttribute("class")||"")+" "+p+": "+x+" in Obsidian, "+y+" in the file");}}'
            'return JSON.stringify({count:diffs.length, diffs:diffs.slice(0,5), shapes:a.length});'
            '}finally{host.remove(); ifr.remove(); document.getElementById("d"+id)?.remove();}})()')
    raw = js(code)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {'error': raw[:300]}


class Scratch:
    """A note with a unique name at the vault root, open in Live Preview; trashed afterwards."""

    def __init__(self, prefix, content):
        self.path = f'{prefix} {time.strftime("%Y%m%d-%H%M%S")}.md'
        self.content = content

    def create(self):
        js("(async()=>{const p=" + json.dumps(self.path) + "; if(app.vault.getAbstractFileByPath(p)) return 'exists';"
           " const f=await app.vault.create(p," + json.dumps(self.content) + "); await app.workspace.getLeaf('tab').openFile(f);"
           " const l=app.workspace.activeLeaf; const s=l.getViewState(); s.state.mode='source'; s.state.source=false; await l.setViewState(s);"
           " await new Promise(r=>setTimeout(r,1500)); return 'ok'})()")

    def ready(self, timeout=60):
        """
        Waits until the note's diagram is drawn and editable, then a moment longer; call it once the
        diagram is scrolled into view (Live Preview draws a block only then). On an Obsidian started
        just before the run, the first drawing loads the bundled Mermaid and may be drawn twice;
        input sent meanwhile hit a drawing that was replaced (the first two cases failed).
        """
        end = time.time() + timeout
        while time.time() < end:
            if js("String(!!app.workspace.activeLeaf?.view?.contentEl?.querySelector('.mermaid svg[data-mp-src]'))") == 'true':
                wait(2)
                return
            wait(0.5)
        raise RuntimeError(f'no editable diagram drawn in {self.path} after {timeout} s')

    def active(self):
        return js("app.workspace.activeLeaf?.view?.file?.path ?? ''") == self.path

    def text(self):
        return js("app.workspace.activeLeaf.view.editor.getValue()")

    def trash(self):
        # A case that unloads the plugin must never leave it unloaded.
        js('(async()=>{const id=' + json.dumps(PLUGIN_ID) + '; if(!app.plugins.plugins[id]) await app.plugins.enablePlugin(id); return "ok"})()')
        js("(async()=>{const p=" + json.dumps(self.path) + "; const ls=[]; app.workspace.iterateAllLeaves(l=>{if(l.view?.file?.path===p) ls.push(l)});"
           " ls.forEach(l=>l.detach()); const f=app.vault.getAbstractFileByPath(p); if(f) await app.fileManager.trashFile(f); return 'ok'})()")


def plugin_setting(name, value):
    """Sets a plugin setting through its setter (e.g. `fullWidth`), returns the previous value."""
    setter = 'set' + name[0].upper() + name[1:]
    return json.loads(js('(async()=>{const p=app.plugins.plugins[' + json.dumps(PLUGIN_ID) + ']; const old=p.settings[' + json.dumps(name)
                         + ']; await p[' + json.dumps(setter) + '](' + json.dumps(value) + '); return JSON.stringify(old)})()') or 'null')


def app_config(name, value):
    """Sets an Obsidian setting (e.g. `readableLineLength`), returns the previous value."""
    return json.loads(js('(()=>{const old=app.vault.getConfig(' + json.dumps(name) + '); app.vault.setConfig(' + json.dumps(name) + ', '
                         + json.dumps(value) + '); app.workspace.updateOptions?.(); return JSON.stringify(old)})()') or 'null')


def run(cases, scratch, park, between=None, settings=None, config=None):
    """
    Runs the cases whose name contains argv[1] on `scratch`; exit 0 when all passed. `settings`
    are plugin settings and `config` Obsidian settings held for the run (so the diagram fits the
    screen) and restored afterwards.
    """
    sel = sys.argv[1] if len(sys.argv) > 1 else ''
    held = {k: plugin_setting(k, v) for k, v in (settings or {}).items()}
    held_config = {k: app_config(k, v) for k, v in (config or {}).items()}
    failed = 0
    try:
        scratch.create()
        park()
        scratch.ready()
        for name, fn in cases:
            if sel not in name:
                continue
            if not scratch.active():
                print(f'ABORT {name:20} the active note is not the scratch note, stopping before input lands elsewhere')
                failed += 1
                break
            park()
            try:
                ok, detail = fn()
            except Exception as e:  # a crashed case is a failed case
                ok, detail = False, f'{type(e).__name__}: {e}'
            print(f'{"PASS" if ok else "FAIL"}  {name:20} {detail}')
            failed += 0 if ok else 1
            close_modals()
            if between:
                between()
    finally:
        # The user's settings first (app settings travel to every device with Sync), then the note.
        for k, v in held.items():
            plugin_setting(k, v)
        for k, v in held_config.items():
            app_config(k, v)
        try:
            scratch.trash()
        except Exception as e:
            print(f'WARN  could not trash {scratch.path}: {e}')
    print(f'{"OK" if failed == 0 else "FAILED"}: {failed} failed')
    sys.exit(1 if failed else 0)

