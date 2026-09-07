"""Mobile UX audit (dev tool, not part of the Node suite).

Drives the game at phone / small-phone / landscape viewports through the base tutorial, a turn
vs the AI, forced discard / AI-thinking / undo / menu / win states, the online lobby and a hotseat
pass, screenshotting each state and flagging the bug class that has bitten twice on phones:
  - an interactive element whose centre is covered by a higher-z fixed/sticky overlay
    (tutorial bubble, dock, undo button, sticky tier label, topbar)
  - page-level horizontal overflow, clipped button text, tap targets < 40px
  - tutorial bubble overlapping the action bar / spotlight, spotlight target off-screen

Setup (once):  pip install playwright pillow && python -m playwright install chromium
Run:           python -m http.server 8765 --bind 127.0.0.1   (from the repo root, separate shell)
               python test/mobile_ux_audit.py [phone] [small] [land]
Output:        test/_ux_audit/<vp>_<state>.png, sheet_<vp>_N.png contact sheets, <vp>_report.json,
               and a per-state summary on stdout. Tutorial STEP-FAIL lines can be driver timing
               (first-try selectors); treat COVERED / TARGET-OFFSCREEN / BUBBLE-OVERLAP as real.
"""
import json, os, time, math, sys
sys.stdout.reconfigure(encoding="utf-8")   # Windows console defaults to GBK; button labels contain ✕ etc.
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFont

BASE = "http://127.0.0.1:8765/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ux_audit")
os.makedirs(OUT, exist_ok=True)
VIEWPORTS = {
  "phone": dict(viewport={"width":393,"height":852}, device_scale_factor=2, is_mobile=True, has_touch=True),
  "small": dict(viewport={"width":360,"height":740}, device_scale_factor=2, is_mobile=True, has_touch=True),
  "land":  dict(viewport={"width":852,"height":393}, device_scale_factor=2, is_mobile=True, has_touch=True),
}
AUDIT_JS = r"""
() => {
  const vw = innerWidth, vh = innerHeight;
  const desc = (el) => { if(!el) return 'null'; let s = el.tagName.toLowerCase(); if (el.id) s += '#'+el.id; if (el.classList && el.classList.length) s += '.'+[...el.classList].slice(0,3).join('.'); const da = el.getAttribute && el.getAttribute('data-act'); if (da) s += '[act='+da+']'; const t = (el.textContent||'').trim().replace(/\s+/g,' ').slice(0,16); if (t && ['BUTTON','A'].includes(el.tagName)) s += ' "'+t+'"'; return s; };
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)===0) return false; const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const inView = (r) => r.bottom>0 && r.top<vh && r.right>0 && r.left<vw;
  const sel = 'button:not([disabled]), [role="button"], a[href], input, select, .card[data-card], .deck-pile, .supply-row[data-color], .evo-option, [data-act], .choice-card';
  const els = [...document.querySelectorAll(sel)].filter(vis);
  const covered = [], small = [], clipped = [];
  for (const el of els) {
    const r = el.getBoundingClientRect(); if (!inView(r)) continue;
    const cx = Math.min(vw-1, Math.max(0, r.left + r.width/2)), cy = Math.min(vh-1, Math.max(0, r.top + r.height/2));
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      let ov = hit, name = desc(hit);
      while (ov && ov !== document.body) { const cs = getComputedStyle(ov); if (cs.position==='fixed' || cs.position==='sticky') { name = desc(ov) + ' (' + cs.position + ' z=' + cs.zIndex + ')'; break; } ov = ov.parentElement; }
      covered.push({ el: desc(el), by: name, rect: [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)] });
    }
    if (r.width < 40 || r.height < 40) small.push({ el: desc(el), w: Math.round(r.width), h: Math.round(r.height) });
  }
  for (const el of document.querySelectorAll('button, #turn-banner, .tier-label, .mychip, .act-hint, #tut-title, .supply-row .cnt, #lobby-code')) {
    if (!vis(el)) continue; const r = el.getBoundingClientRect(); if (!inView(r)) continue;
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible') clipped.push({ el: desc(el), sw: el.scrollWidth, cw: el.clientWidth });
  }
  const rect = (q) => { const e = document.querySelector(q); if (!e || !vis(e)) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; };
  const bubble = rect('#tut-bubble'), mask = rect('#tut-mask'), dock = rect('#controls'), bar = rect('#action-bar');
  const inter = (a,b) => !!(a && b && a[0] < b[0]+b[2] && a[0]+a[2] > b[0] && a[1] < b[1]+b[3] && a[1]+a[3] > b[1]);
  return { vw, vh, hOverflow: document.documentElement.scrollWidth > vw + 1, docW: document.documentElement.scrollWidth,
    covered, small: small.slice(0,40), clipped, bubble, mask, dock, bar,
    bubbleOverDock: inter(bubble, dock), bubbleOverBar: inter(bubble, bar), bubbleOverMask: inter(bubble, mask),
    maskInView: mask ? (mask[1] >= 0 && mask[1]+mask[3] <= vh) : null };
}
"""

def run(vpname, opts):
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(**opts, locale="zh-CN"); page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text[:160]) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)[:160]))
        report, shots = {}, []
        def snap(name):
            path = f"{OUT}/{vpname}_{name}.png"; page.screenshot(path=path)
            a = page.evaluate(AUDIT_JS); a["errors"] = errors[:]; errors.clear(); report[name] = a; shots.append((name, path))
        tap = (lambda s: page.tap(s, timeout=2500)) if opts.get("has_touch") else (lambda s: page.click(s, timeout=2500))
        clk = lambda s: page.click(s, timeout=2500)
        def safe(fn, *a):
            try: fn(*a); return True
            except Exception as e: errors.append("STEP-FAIL " + str(e).split('\n')[0][:110]); return False
        W = lambda ms: page.wait_for_timeout(ms)
        def fresh():
            page.goto(BASE + "?nocache=" + str(time.time()), wait_until="load"); W(600)

        fresh(); snap("00_setup")
        # ---- base tutorial ----
        safe(tap, "#tutorial-btn"); W(800); snap("t1_welcome")
        safe(clk, "#tut-actions button.primary"); W(500); snap("t2_take3_instr")
        for c in ("red", "blue", "black"): safe(tap, f'.supply-row[data-color="{c}"]'); W(180)
        W(300); snap("t2_take3_picked")
        safe(tap, '[data-act="confirm-take"]'); W(700); snap("t3_take2_instr")
        for _ in range(2): safe(tap, '.supply-row[data-color="black"]'); W(180)
        W(300); snap("t3_take2_picked")
        safe(tap, '[data-act="confirm-take"]'); W(700); snap("t4_capture_instr")
        safe(tap, '.card[data-card="s1_04"]'); W(600); snap("t4_card_tapped")
        if not safe(clk, '#inspect:not(.hidden) [data-act="capture"]'): safe(clk, '[data-act="capture"]')
        W(900); snap("t5_evolve_instr")
        safe(clk, '.evo-option'); W(900); snap("t6_reserve_instr")
        safe(tap, '.deck-pile.reservable'); W(600); snap("t6_deck_tapped")
        if not safe(clk, '#inspect:not(.hidden) [data-act="reserve-deck"]'): safe(clk, '[data-act="reserve-deck"]')
        W(900); snap("t7_win_instr")
        safe(tap, '.card[data-card="s3_11"]'); W(600)
        if not safe(clk, '#inspect:not(.hidden) [data-act="capture"]'): safe(clk, '[data-act="capture"]')
        W(1300); snap("t8_finish")
        # ---- normal game vs AI ----
        fresh(); safe(clk, "#start-btn"); W(900); snap("g1_turn_idle")
        for c in ("red", "blue", "black"): safe(tap, f'.supply-row[data-color="{c}"]'); W(150)
        W(300); snap("g2_pick3")
        safe(tap, '[data-act="clear-take"]'); W(300)
        safe(tap, '.tier-row .card[data-card]'); W(600); snap("g3_card_tapped")
        safe(clk, '#inspect:not(.hidden) [data-inspect-close]'); W(300); safe(clk, '[data-act="clear-sel"]'); W(200)
        page.evaluate("()=>{const d=window.PSDebug; const p=d.G.players[d.G.turn]; p.tokens.red=6;p.tokens.blue=5; d.G.acted=true; d.UI.phase='discard'; d.render();}")
        W(400); snap("g4_discard")
        page.evaluate("()=>{const d=window.PSDebug; d.UI.phase='main'; d.G.acted=false; const p=d.G.players[d.G.turn]; for(const k in p.tokens)p.tokens[k]=0; d.render();}")
        for c in ("red", "blue", "black"): safe(tap, f'.supply-row[data-color="{c}"]'); W(120)
        safe(tap, '[data-act="confirm-take"]'); W(400); safe(clk, '[data-act="end-turn"]'); W(700); snap("g5_ai_thinking")
        W(4800); snap("g6_after_ai_undo")
        safe(clk, "#menu-btn"); W(400); snap("g7_menu"); page.keyboard.press("Escape"); W(250)
        page.evaluate("()=>{const d=window.PSDebug; d.G.phase='gameover'; d.G.winner=0; d.showWin();}"); W(500); snap("g8_win")
        # ---- online lobby (WS fails on static server -> audits the disconnected UX) ----
        fresh(); safe(tap, "#online-create"); W(2500); snap("o1_lobby")
        # ---- hotseat 2 humans -> pass overlay ----
        fresh()
        page.evaluate("()=>{for(const el of document.querySelectorAll('select')){const o=[...el.options].find(o=>/真人/.test(o.textContent)); if(o&&el.value!==o.value){el.value=o.value; el.dispatchEvent(new Event('change',{bubbles:true}));}}}")
        W(200); safe(clk, "#start-btn"); W(700); snap("h1_hotseat_start")
        for c in ("red", "blue", "black"): safe(tap, f'.supply-row[data-color="{c}"]'); W(120)
        safe(tap, '[data-act="confirm-take"]'); W(300); safe(clk, '[data-act="end-turn"]'); W(600); snap("h2_pass_overlay")
        json.dump(report, open(f"{OUT}/{vpname}_report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        b.close(); return report, shots

def sheets(vpname, shots, tw):
    try: f = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 16)
    except Exception: f = None
    per, cols = (12, 4) if tw < 300 else (8, 2); paths = []
    for si in range(0, len(shots), per):
        chunk = shots[si:si + per]; ims = []
        for name, path in chunk:
            im = Image.open(path); ims.append((name, im.resize((tw, int(tw * im.height / im.width)))))
        th = max(i.height for _, i in ims); rows = math.ceil(len(ims) / cols)
        S = Image.new("RGB", (cols * (tw + 8) + 8, rows * (th + 26) + 8), (18, 20, 36)); d = ImageDraw.Draw(S)
        for k, (name, im) in enumerate(ims):
            c, r = k % cols, k // cols; x, y = 8 + c * (tw + 8), 8 + r * (th + 26)
            S.paste(im, (x, y + 22)); d.text((x, y + 3), name, fill=(255, 225, 120), font=f)
        p = f"{OUT}/sheet_{vpname}_{si // per}.png"; S.save(p); paths.append(p)
    return paths

MODAL = {"t4_card_tapped", "t6_deck_tapped", "g3_card_tapped", "g7_menu", "g8_win", "h2_pass_overlay"}
if len(sys.argv) > 1: VIEWPORTS = {k: v for k, v in VIEWPORTS.items() if k in sys.argv[1:]}
for vp, opts in VIEWPORTS.items():
    t0 = time.time(); rep, shots = run(vp, opts); ps = sheets(vp, shots, 240 if vp != "land" else 440)
    print(f"\n##### {vp} ({time.time() - t0:.0f}s) sheets: {[os.path.basename(x) for x in ps]}")
    for name, a in rep.items():
        flags = []
        if a["hOverflow"]: flags.append(f"H-OVERFLOW docW={a['docW']}>{a['vw']}")
        cov = a["covered"]
        if cov and name not in MODAL: flags.append("COVERED " + "; ".join(f"{c['el']} <- {c['by']}" for c in cov[:6]) + (f" (+{len(cov) - 6})" if len(cov) > 6 else ""))
        if a["clipped"]: flags.append("CLIPPED " + "; ".join(f"{c['el']} {c['sw']}>{c['cw']}" for c in a["clipped"][:5]))
        if a["bubble"] and (a["bubbleOverBar"] or a["bubbleOverMask"]): flags.append(f"BUBBLE-OVERLAP bar={a['bubbleOverBar']} mask={a['bubbleOverMask']} dock={a['bubbleOverDock']} bubble={a['bubble']} bar={a['bar']} mask={a['mask']}")
        if a["mask"] and a["maskInView"] is False: flags.append(f"TARGET-OFFSCREEN mask={a['mask']} vh={a['vh']}")
        if a["errors"]: flags.append("ERR " + " | ".join(a["errors"][:3]))
        tiny = [s for s in a["small"] if s["h"] < 32 or s["w"] < 32]
        print(f"  {name:20s} " + (" || ".join(flags) if flags else "ok") + (f"  [small<32: {len(tiny)}]" if tiny else ""))
