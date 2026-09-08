"""PokéMart: highlight the next action and keep the guide readable.

Serve the repo on localhost:8765, then run python test/tutorial_actions.test.py.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    for engine in ['chromium', 'webkit']:
        browser = getattr(p, engine).launch()
        for width, height in [(1880, 895), (393, 717), (852, 393)]:
            ctx = browser.new_context(viewport={'width': width, 'height': height},
                                      has_touch=width < 1000, is_mobile=width < 1000,
                                      service_workers='block')
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('http://127.0.0.1:8765/')
            page.locator('#tutorial-pokemart-btn').click()
            page.locator('#tut-actions button.primary').click()
            for card in ['pm_12', 'pm_23']:
                page.wait_for_function('!PSGame.UI.busy')
                if card == 'pm_23':
                    page.wait_for_function("!PSGame.G.acted || PSGame.UI.phase === 'evolve'")
                    if page.evaluate('PSGame.G.acted'):
                        expect(page.locator('#tut-next')).to_contain_text('结束回合')
                        page.locator('[data-act="end-turn"]').click()
                print(f'Checking {engine} {width}: {card}', flush=True)
                page.locator(f'.card[data-card="{card}"]').click()
                button = page.locator('#action-bar [data-act="capture"]')
                expect(button).to_be_enabled()
                expect(page.locator('#tut-next')).to_contain_text('购买道具')
                assert page.locator('#tut-details').get_attribute('open') is None
                page.wait_for_timeout(150)
                assert button.evaluate('''el => {
                  const b=el.getBoundingClientRect(), m=document.querySelector('#tut-mask').getBoundingClientRect();
                  const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
                  return m.top<=b.top && m.bottom>=b.bottom && m.left<=b.left && m.right>=b.right
                    && (hit===el || el.contains(hit));
                }'''), 'next action must be highlighted and hit-testable'
                fits = page.locator('#tut-bubble').evaluate('''el => {
                  const r=el.getBoundingClientRect();
                  return r.top>=0 && r.bottom<=innerHeight && el.scrollHeight<=el.clientHeight+1;
                }''')
                if not fits:
                    print(page.locator('#tut-bubble').evaluate('(el)=>({rect:el.getBoundingClientRect().toJSON(),scroll:el.scrollHeight,client:el.clientHeight,bar:document.querySelector("#action-bar").getBoundingClientRect().toJSON()})'))
                assert fits, 'guide should fit without scrolling its title or buttons away'
                # Reading optional rules must not hide the footer or the action.
                page.locator('#tut-details summary').click()
                page.wait_for_timeout(100)
                assert page.locator('#tut-actions button').last.evaluate('''el => {
                  const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
                  return hit===el || el.contains(hit);
                }'''), 'exit stays reachable with expanded rules'
                page.locator('#tut-details summary').click()
                if card == 'pm_23':
                    out = Path(__file__).parent / '_ux_audit'; out.mkdir(exist_ok=True)
                    page.screenshot(path=str(out / f'{engine}_{width}_pokemart.png'))
                button.click()
                if card == 'pm_12':
                    expect(page.locator('#tut-step')).to_contain_text('3 / 8')
            expect(page.locator('#choice-modal')).to_be_visible()
            assert not errors, errors
            ctx.close()
            print(f'PASS {engine} {width}x{height}: potion and TM action highlights, guide, choice modal')
        browser.close()
