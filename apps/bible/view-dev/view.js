// Developer view only: lists a chapter, searches, and toggles a bookmark through the contract's bridge, to test the
// path from the Desk app's frame to the app. The product view is the UI/UX Engineer's, in apps/bible/view/.
"use strict";

// The bridge, from the contract sample's view (spikes/app-contract-sample/app/view/view.js).
const bridge = (() => {
  let port = null;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((resolve) => {
    addEventListener("message", (e) => {
      if (e.source !== parent || !e.data || e.data.t !== "ma.bridge" || !e.ports[0] || port) return;
      port = e.ports[0];
      port.onmessage = ({ data }) => {
        if (data.t === "res" || data.t === "err") {
          const p = pending.get(data.id);
          pending.delete(data.id);
          if (p) data.t === "res" ? p.resolve(data.res) : p.reject(data.err);
        } else if (data.t === "evt") {
          (listeners.get(data.sub) || (() => {}))(data.evt);
        }
      };
      resolve(e.data);
    });
  });
  const send = (msg) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ ...msg, id });
  });
  return {
    call: async (m, p = {}, idem) => (await ready, send({ t: "call", m, p, idem })),
    subscribe: async (topic, onEvent) => {
      await ready;
      const { subId } = await send({ t: "sub", topic });
      listeners.set(subId, onEvent);
    },
  };
})();

function idemKey() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let t = Date.now();
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const $ = (id) => document.getElementById(id);
const el = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
const say = (s) => { $("status").textContent = s; };
let at = { translation: "bsb", book: "GEN", chapter: 1 };

async function show(ref) {
  at = { translation: "bsb", book: ref.book, chapter: ref.chapter };
  const ch = await bridge.call("bible.chapter", at);
  $("title").textContent = `${ch.bookName} ${ch.chapter}`;
  const marked = new Map(ch.marks.filter((m) => m.kind === "bookmark").map((m) => [m.verse, m.id]));
  const list = $("list");
  list.replaceChildren();
  for (const it of ch.items) {
    if (it.kind !== "verse") { list.append(el("li", it.text)); continue; }
    const li = el("li");
    const b = el("button", marked.has(it.verse) ? "★" : "☆");
    b.setAttribute("aria-pressed", String(marked.has(it.verse)));
    b.setAttribute("aria-label", `Bookmark verse ${it.verse}`);
    b.addEventListener("click", () => toggle(it.verse, marked.get(it.verse)));
    li.append(b, el("span", ` ${it.verse} ${it.text}`));
    list.append(li);
  }
  say("");
}

async function toggle(verse, id) {
  if (id) await bridge.call("bible.mark.remove", { id }, idemKey());
  else await bridge.call("bible.mark.put", { mark: { kind: "bookmark", book: at.book, chapter: at.chapter, verse, translation: "bsb" } }, idemKey());
}

$("go").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await show((await bridge.call("bible.lookup", { q: $("ref").value })).ref); } catch (err) { say(err.code || String(err)); }
});

$("find").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await bridge.call("bible.search", { translation: "bsb", q: $("q").value, limit: 50 });
    $("title").textContent = `${r.total} verses in BSB`;
    const list = $("list");
    list.replaceChildren();
    for (const h of r.hits) {
      const li = el("li");
      const go = el("button", `${h.book} ${h.chapter}:${h.verse}`);
      go.addEventListener("click", () => show(h));
      li.append(go, el("span", " "));
      let i = 0;
      for (const [s, t] of h.ranges) { li.append(document.createTextNode(h.text.slice(i, s)), el("mark", h.text.slice(s, t))); i = t; }
      li.append(document.createTextNode(h.text.slice(i)));
      list.append(li);
    }
    say(r.ref ? `Or go to ${r.ref.book} ${r.ref.chapter}` : "");
  } catch (err) { say(err.code || String(err)); }
});

bridge.subscribe("bible.marks", () => show(at).catch(() => {}));
