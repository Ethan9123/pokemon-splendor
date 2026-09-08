"""Browser regression for names/logs. Serve the repository on localhost:8765."""
from playwright.sync_api import sync_playwright, expect

payload = '<img data-xss src=x onerror="window.__xss=1"> & "name"'
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(service_workers='block')
    page.goto('http://127.0.0.1:8765/')
    page.locator('#start-btn').click()
    page.evaluate('''name => {
      const d = PSDebug;
      d.G.players.forEach(p => { p.name = name; p.isAI = false; });
      d.G.log.push({msg: name}); d.render();
    }''', payload)
    expect(page.locator('#turn-banner')).to_contain_text(payload)
    expect(page.locator('#log-lines')).to_contain_text(payload)
    assert page.locator('img[data-xss]').count() == 0
    page.evaluate("() => {PSDebug.G.phase='gameover'; PSDebug.G.winner=0; PSDebug.showWin();}")
    expect(page.locator('#win-title')).to_contain_text(payload)
    assert page.locator('img[data-xss]').count() == 0
    # Lobby receives remote names before a game has even started.
    page.reload()
    page.evaluate('''() => {
      window.testHandlers = {};
      Net.on = (event, fn) => testHandlers[event] = fn;
      Net.connect = () => {};
    }''')
    page.locator('#online-create').click()
    page.evaluate('''name => testHandlers.roster({players: [
      {seat: 0, name, connected: true}
    ], hostSeat: 0, started: false})''', payload)
    expect(page.locator('#lobby-roster')).to_contain_text(payload)
    assert page.locator('img[data-xss]').count() == 0
    assert page.evaluate('window.__xss || 0') == 0
    browser.close()
    print('PASS untrusted names render as text in game, logs, results and lobby')
