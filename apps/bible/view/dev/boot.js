// Copied unchanged below this line from web/src/deskapps/host/boot.js on sub/apps-host (bee16127), so the harness boots the view
// exactly as the Desk app does. Refresh it when the host changes its boot.
// The app view's boot (ADR 0054, `frame.ts`), loaded by URL from the office's own origin into the view's sandboxed frame,
// before the view runs and once its markup is parsed. It applies the view's style as a constructed stylesheet, loads the UI
// font from bytes, and runs the view's script from a blob: URL with its hash as `integrity`, which the frame's policy alone
// lets run. Then it tells the office, which hands the view its bridge. Plain script, no imports: it isn't bundled.
"use strict";
(function () {
  var el = function (id) { return document.getElementById(id); };
  var bytes = function (node) {
    var s = atob(node.textContent || "");
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  };
  var said = false;
  var say = function (ok) {
    if (said) return;
    said = true;
    parent.postMessage({ t: "ma.boot", ok: ok }, "*");
  };
  var style = el("ma-style");
  if (style) {
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(new TextDecoder().decode(bytes(style)));
      document.adoptedStyleSheets = [sheet];
    } catch { /* the view without its style is still the view */ }
    style.remove();
  }
  var font = el("ma-font");
  if (font) {
    try {
      var face = new FontFace(font.dataset.family || "UI", bytes(font), { weight: "100 900" });
      document.fonts.add(face);
      face.load().catch(function () {});
    } catch { /* the system font, then */ }
    font.remove();
  }
  var view = el("ma-view");
  if (!view) return say(false);
  var s = document.createElement("script");
  s.src = URL.createObjectURL(new Blob([bytes(view)], { type: "text/javascript" }));
  s.integrity = view.dataset.integrity || "";
  s.async = false;
  s.onload = function () { say(true); };
  s.onerror = function () { say(false); };
  view.remove();
  document.body.appendChild(s);
})();
