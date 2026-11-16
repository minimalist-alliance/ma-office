// The app view's boot (ADR 0054, `frame.ts`), loaded by URL from the office's own origin into the view's sandboxed frame,
// before the view runs and once its markup is parsed. It applies the view's style as a constructed stylesheet, loads the UI
// font from bytes, and runs the view's script from a blob: URL with its hash as `integrity`, which the frame's policy alone
// lets run. First it gives the office the frame budget's probe port and the zoom port (`ma.ports`); once the view runs it
// tells the office (`ma.boot`), which hands the view its bridge. Both carry the office's nonce, which the view never sees.
// Plain script, no imports: it isn't bundled.
"use strict";
(function () {
  var el = function (id) { return document.getElementById(id); };
  var bytes = function (node) {
    var s = atob(node.textContent || "");
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  };
  // The office asks whether this frame runs on its thread (`budget.ts`, `threadOf`): a ping with a fresh nonce on a port of
  // our own, sent while it holds its thread for a moment, answered on the office's window, where its own marker waits in the
  // same queue; an answer queued before the marker came from another thread. Made before the view runs, out of its reach
  // (the parent is kept now, in case the view replaces `window.parent`), and it only ever echoes the nonce.
  var up = window.parent;
  // The office's nonce for this frame (`frame.ts`), read and removed before the view runs, so only these messages carry it.
  var nonceEl = el("ma-nonce");
  var nonce = nonceEl ? nonceEl.textContent || "" : "";
  if (nonceEl) nonceEl.remove();
  var probe = new MessageChannel();
  probe.port1.onmessage = function (e) {
    var d = e.data;
    if (d && d.t === "ma.ping" && typeof d.n === "string") up.postMessage({ t: "ma.pong", n: d.n }, "*");
  };
  // Zoom gestures (ADR 0055): Ctrl or Cmd with the wheel, and a trackpad pinch (Chromium and Firefox send it as a wheel
  // with `ctrlKey`, Safari as GestureEvents), over the view zoom the app's window, as over any office app, rather than
  // magnifying the whole office. They reach only this frame, so they're sent up: on a port of their own that only the
  // office holds, so the view can't send one, and only what the member's own gesture did (`isTrusted`), only for one the
  // view didn't take for itself (`preventDefault` on the document or below), and only numbers: the wheel's delta, its mode
  // and whether a key was held, or a pinch's step. No point, no target, no other event, nothing of the page. The natives are
  // kept now, before the view runs, so a view that replaces them can't change what's read or sent.
  var zoom = new MessageChannel();
  var R = Reflect.apply;
  var send = zoom.port1.postMessage;
  var port = zoom.port1;
  var getter = function (proto, name) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, name);
    return d && d.get;
  };
  var listen = EventTarget.prototype.addEventListener;
  var stop = Event.prototype.preventDefault;
  var taken = getter(Event.prototype, "defaultPrevented");
  var ctrl = getter(MouseEvent.prototype, "ctrlKey");
  var meta = getter(MouseEvent.prototype, "metaKey");
  var dy = getter(WheelEvent.prototype, "deltaY");
  var mode = getter(WheelEvent.prototype, "deltaMode");
  var keyOf = getter(KeyboardEvent.prototype, "key");
  var typeOf = getter(Event.prototype, "type");
  var scaleOf = typeof GestureEvent === "function" ? getter(GestureEvent.prototype, "scale") : null;
  var touchesOf = typeof TouchEvent === "function" ? getter(TouchEvent.prototype, "touches") : null;
  var lengthOf = typeof TouchList === "function" ? getter(TouchList.prototype, "length") : null;
  var num = function (n, lo, hi) { return typeof n !== "number" || n !== n ? 0 : n < lo ? lo : n > hi ? hi : n; };
  var up1 = function (m) { try { R(send, port, [m]); } catch { /* the office went */ } };
  var controlDown = false;
  var touching = false;
  var lastScale = 1;
  var onKey = function (e) { if (e.isTrusted && R(keyOf, e, []) === "Control") controlDown = R(typeOf, e, []) === "keydown"; };
  var onTouch = function (e) { if (e.isTrusted && touchesOf && lengthOf) touching = R(lengthOf, R(touchesOf, e, []), []) > 0; };
  var onWheel = function (e) {
    if (!e.isTrusted || R(taken, e, [])) return;
    var isMeta = !!R(meta, e, []);
    if (!R(ctrl, e, []) && !isMeta) return;
    R(stop, e, []);
    up1({ w: num(R(dy, e, []), -10000, 10000), m: num(R(mode, e, []), 0, 2) | 0, k: controlDown || isMeta });
  };
  var onGesture = function (e) {
    if (!e.isTrusted) return;
    // Safari's own magnifying of the office, stopped for every one, as the office stops it over itself.
    R(stop, e, []);
    var type = R(typeOf, e, []);
    var scale = scaleOf ? num(R(scaleOf, e, []), 0, 100) : 1;
    if (type === "gesturestart") { lastScale = scale > 0 ? scale : 1; return; }
    if (type !== "gesturechange" || touching || !(scale > 0) || !(lastScale > 0)) return;
    var step = scale / lastScale;
    lastScale = scale;
    if (step !== 1) up1({ g: num(step, 0.1, 10) });
  };
  // Both ports go up now, before the view runs and can touch anything a transfer goes through.
  up.postMessage({ t: "ma.ports", n: nonce }, "*", [probe.port2, zoom.port2]);
  var said = false;
  var say = function (ok) {
    if (said) return;
    said = true;
    up.postMessage({ t: "ma.boot", ok: ok, n: nonce }, "*");
    if (!ok) return;
    // After the view's own start, so a listener it adds on the window as it starts hears these first, as in the office.
    var on = function (type, fn, opts) { R(listen, window, [type, fn, opts]); };
    var active = { passive: false };
    on("keydown", onKey, { capture: true, passive: true });
    on("keyup", onKey, { capture: true, passive: true });
    on("blur", function () { controlDown = false; }, {});
    on("touchstart", onTouch, { capture: true, passive: true });
    on("touchend", onTouch, { capture: true, passive: true });
    on("touchcancel", onTouch, { capture: true, passive: true });
    on("wheel", onWheel, active);
    on("gesturestart", onGesture, active);
    on("gesturechange", onGesture, active);
    on("gestureend", onGesture, active);
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
