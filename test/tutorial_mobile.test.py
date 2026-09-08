"""Real touch/DOM regression: run with the repo served at localhost:8765.

python test/tutorial_mobile.test.py [chromium|webkit|msedge]
No force clicks: confirmation must be visible and hit-testable.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

def check_button(page):
    button = page.locator('[data-act="confirm-take"]')
    expect(button).to_be_enabled()
    page.wait_for_timeout(150)
    assert button.evaluate('''el => {
      const r = el.getBoundingClientRect(), vv = visualViewport;
      const top = vv ? vv.offsetTop : 0, bottom = top + (vv ? vv.height : innerHeight);
      const hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
      return r.top >= top && r.bottom <= bottom && (hit === el || el.contains(hit));
    }'''), 'confirm button is offscreen, clipped or covered'

with sync_playwright() as p:
    engine = sys.argv[1] if len(sys.argv) > 1 else 'chromium'
    browser = p.chromium.launch(channel='msedge') if engine == 'msedge' else getattr(p, engine).launch()
    for width, height in [(393, 717), (360, 640), (852, 393)]:
        context = browser.new_context(viewport={'width': width, 'height': height},
                                      is_mobile=True, has_touch=True, service_workers='block')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:8765/')
        page.locator('#tutorial-btn').tap()
        page.locator('#tut-actions button.primary').tap()
        for color in ['red', 'blue', 'black']:
            page.locator(f'.supply-row[data-color="{color}"]').tap()
        check_button(page)
        # Browser chrome / orientation changes while waiting for confirmation.
        page.set_viewport_size({'width': width, 'height': max(320, height - 120)})
        check_button(page)
        page.locator('[data-act="confirm-take"]').tap()
        expect(page.locator('#tut-step')).to_contain_text('3 / 7')
        for _ in range(2):
            page.locator('.supply-row[data-color="black"]').tap()
        check_button(page)
        page.locator('[data-act="confirm-take"]').tap()
        expect(page.locator('#tut-step')).to_contain_text('4 / 7')
        # Short bubbles must remain scrollable: exit used to jump away when
        # scrolling its footer triggered a natural-height remeasurement.
        page.locator('#tut-actions button').filter(has_text='退出教程').tap()
        expect(page.locator('#tut-bubble')).to_be_hidden()
        page.locator('#tutorial-btn').tap()
        page.locator('#tut-actions button.primary').tap()
        for color in ['red', 'blue', 'black']:
            page.locator(f'.supply-row[data-color="{color}"]').tap()
        check_button(page)
        out = Path(__file__).parent / '_ux_audit'
        out.mkdir(exist_ok=True)
        page.screenshot(path=str(out / f'{engine}_{width}_confirm.png'))
        page.locator('[data-act="confirm-take"]').tap()
        expect(page.locator('#tut-step')).to_contain_text('3 / 7')
        assert not errors, errors
        context.close()
        print(f'PASS {width}x{height}: take three, resize, take two, exit')
    browser.close()
