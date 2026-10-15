"""Multi-browser online smoke test against Wrangler local or an isolated live room.

python test/online_flow.test.py [http://127.0.0.1:8765] [chromium|webkit]
Creates its own random room, never interacts with existing rooms.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765').rstrip('/')
ENGINE = sys.argv[2] if len(sys.argv) > 2 else 'chromium'
def ready(page):
    page.wait_for_function('window.Net && Net.isOpen() && PSGame.UI.net && PSGame.UI.net.seat !== null')

with sync_playwright() as p:
    browser = getattr(p, ENGINE).launch()
    contexts = [browser.new_context(service_workers='block', viewport={'width': 393, 'height': 717},
                                    is_mobile=True, has_touch=True) for _ in range(3)]
    pages = [c.new_page() for c in contexts]
    host, guest, watcher = pages
    errors = []
    for page in pages:
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_default_timeout(20000)
    try:
        host.goto(BASE)
        host.locator('#online-create').click(); ready(host)
        invite = host.url
        guest.goto(invite); ready(guest)
        expect(host.locator('.lr-row:not(.lr-empty)')).to_have_count(2)
        host.locator('[data-add]').first.click()
        expect(host.locator('.lr-row:not(.lr-empty)')).to_have_count(3)
        host.locator('.lr-diff').select_option('easy')
        expect(guest.locator('.lr-lv')).to_contain_text('新手')
        host.locator('#lobby-shuffle').click()
        expect(guest.locator('#lobby-tools')).to_contain_text('已随机 1 次')
        host.context.set_offline(True)
        expect(host.locator('#lobby-start')).to_be_disabled()
        expect(host.locator('#lobby-retry')).to_be_visible()
        host.context.set_offline(False); ready(host)
        host.locator('#lobby-start').click()
        for page in [host, guest]:
            expect(page.locator('#game')).to_be_visible()
        host.wait_for_function('PSGame.G && !PSGame.G.players[PSGame.G.turn].isAI')
        turn = host.evaluate('PSGame.G.turn')
        actor = next(pg for pg in [host, guest] if pg.evaluate('PSGame.UI.net.seat') == turn)
        other = guest if actor == host else host
        actor.locator('.deck-pile.reservable').first.click()
        actor.locator('[data-act="reserve-deck"]').click()
        actor.wait_for_function('PSGame.G.players[PSGame.UI.net.seat].reserve.length === 1')
        reserved = actor.evaluate('PSGame.G.players[PSGame.UI.net.seat].reserve[0]')
        other.wait_for_function('(seat) => PSGame.G.players[seat].reserve.length === 1', arg=turn)
        assert other.evaluate('(seat) => PSGame.G.players[seat].reserve[0].hidden', turn)
        watcher.goto(invite); ready(watcher)
        assert watcher.evaluate('PSGame.UI.net.seat') == -1
        expect(watcher.locator('#net-bar')).to_contain_text('观战')
        # A real offline/online cycle keeps the private reserve and ownership.
        actor.context.set_offline(True)
        actor.wait_for_function('!Net.isOpen()')
        expect(actor.locator('#net-bar')).to_contain_text('网络已断开')
        out = Path(__file__).parent / '_ux_audit'; out.mkdir(exist_ok=True)
        actor.screenshot(path=str(out / f'online_offline_{ENGINE}.png'))
        actor.context.set_offline(False); ready(actor)
        actor.wait_for_function('(id) => PSGame.G.players[PSGame.UI.net.seat].reserve[0] === id', arg=reserved)
        actor.reload(); ready(actor)
        assert actor.evaluate('PSGame.UI.net.seat') == turn
        actor.wait_for_function('(id) => PSGame.G.players[PSGame.UI.net.seat].reserve[0] === id', arg=reserved)
        # Leaving through the actual menu must close the transport, not resurrect the game.
        actor.once('dialog', lambda d: d.accept())
        actor.locator('#menu-btn').click()
        expect(actor.locator('#setup')).to_be_visible()
        assert actor.evaluate('!Net.isOpen() && !PSGame.UI.net')
        actor.wait_for_timeout(1500)
        expect(actor.locator('#game')).to_be_hidden()
        assert not errors, errors
        print(f'PASS {ENGINE}: lobby, AI, shuffle, start, reserve privacy, spectator, offline/reload and leave')
    finally:
        for ctx in contexts: ctx.close()
        browser.close()
