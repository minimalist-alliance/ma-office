// On the test page only, and only when the page asks: the extension's own menu page in a frame over the page, as a
// password manager's in-page menu is.
if (location.pathname === '/vault') {
  addEventListener('message', (e) => {
    if (e.data !== 'show-vault' || document.getElementById('vault-menu')) return;
    const f = document.createElement('iframe');
    f.id = 'vault-menu';
    f.src = chrome.runtime.getURL('menu.html');
    f.style.cssText = 'position:fixed;left:120px;top:120px;width:520px;height:320px;border:0;z-index:2147483647;background:#fff';
    document.documentElement.append(f);
  });
}
