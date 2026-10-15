"""Play a legal two-human game using AI decisions, then recover a missed rematch.
Serve with Wrangler on localhost:8765; no state is patched on the server.
"""
import sys
from playwright.sync_api import sync_playwright, expect
base = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765').rstrip('/')
with sync_playwright() as p:
    browser = p.chromium.launch()
    contexts = [browser.new_context(service_workers='block') for _ in range(2)]
    pages = [ctx.new_page() for ctx in contexts]
    a,b = pages
    try:
        a.goto(base); a.locator('#online-create').click()
        a.wait_for_function('Net.isOpen()'); b.goto(a.url); b.wait_for_function('Net.isOpen()')
        expect(a.locator('#lobby-start')).to_be_enabled(); a.locator('#lobby-start').click()
        for pg in pages: pg.wait_for_function('PSGame.G && PSGame.UI.net.started')
        for i in range(600):
            state = a.evaluate('({phase:PSGame.G.phase,turn:PSGame.G.turn,seq:PSGame.UI.net.lastSeq})')
            if state['phase'] == 'gameover': break
            active = pages[state['turn']]
            active.wait_for_function('(s)=>PSGame.UI.net.lastSeq >= s && Net.isOpen()', arg=state['seq'])
            active.evaluate('''() => {
              const g=PSGame.G, me=g.players[g.turn], e=PSGame.E;
              if (g.phase!=='play' || g.turn!==PSGame.UI.net.seat) return;
              if (e.needsDiscard(g,me)) {Net.action({type:'discard',color:e.ALL_TOKENS.find(c=>me.tokens[c]>0)});return;}
              if (g.acted) {Net.action({type:'endTurn'});return;}
              const plan=AI.chooseTurn(g,{difficulty:'hard'});
              Net.action(plan.action);
            }''')
            a.wait_for_function('(s)=>PSGame.UI.net.lastSeq > s',arg=state['seq'])
            if i % 50 == 0: print('Actions processed:',i,flush=True)
        else: raise AssertionError('match did not terminate within bounded action budget')
        for pg in pages: expect(pg.locator('#win-modal')).to_be_visible()
        # Guest is offline during the rematch event; reconnect must replace the
        # old game and close its win modal based on the current roster alone.
        b.context.set_offline(True); b.wait_for_function('!Net.isOpen()')
        assert a.evaluate('Net.rematch()')
        expect(a.locator('#lobby')).to_be_visible()
        b.context.set_offline(False)
        b.wait_for_function('Net.isOpen() && !PSGame.UI.net.started && !PSGame.G')
        expect(b.locator('#lobby')).to_be_visible(); expect(b.locator('#win-modal')).to_be_hidden()
        a.locator('#lobby-start').click()
        for pg in pages:
            expect(pg.locator('#game')).to_be_visible()
            pg.wait_for_function('PSGame.G && PSGame.G.phase === "play"')
        print('PASS legal full match, shared result, offline rematch recovery, second game')
    finally:
        for ctx in contexts: ctx.close()
        browser.close()
