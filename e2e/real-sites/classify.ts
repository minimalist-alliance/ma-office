// From what a page showed to pass, challenge or block. Read from the page itself in the desk's Chromium, over CDP: its title,
// its text, its address, its main document's status, its frames and its videos. The frames saved beside each result are for a
// person to confirm the call, and the README says how.
//
// - pass:      the site's own page, usable as a member would expect
// - challenge: a CAPTCHA or bot check a person could get through (a click, a puzzle, a press and hold, or "sign in to prove it")
// - block:     the site refuses the desk's address outright, with no check to pass
// - unclear:   none of the above could be told from the page; look at the frame

export type Verdict = 'pass' | 'challenge' | 'block' | 'unclear';

export interface Probe {
  title: string; host: string; path: string; scheme: string; status: number | null; readyState: string; textLength: number; text: string;
  frames: { host: string; path: string; w: number; h: number }[]; videos: { paused: boolean; t: number; vw: number; vh: number; x: number; y: number; w: number; h: number; err: number; muted: boolean }[];
  resources: number; webdriver: boolean; ua: string; lang: string; iw: number; ih: number; pxCaptcha: boolean; scrollY: number; scrollHeight: number;
}

/** In the page on the desk. Text is cut at 5000 characters, so the reply stays well under Run Command's 24,000. */
export const PROBE = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const text = norm(document.body ? document.body.innerText : '');
  const nav = performance.getEntriesByType('navigation')[0];
  const frames = [...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); let host = '', path = ''; try { const u = new URL(f.src || 'about:blank', location.href); host = u.hostname; path = u.pathname.slice(0, 60); } catch (e) {} return { host, path, w: Math.round(r.width), h: Math.round(r.height) }; }).filter((f) => f.host);
  const videos = [...document.querySelectorAll('video')].map((v) => { const r = v.getBoundingClientRect(); return { paused: v.paused, t: +v.currentTime.toFixed(1), vw: v.videoWidth, vh: v.videoHeight, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), err: v.error ? v.error.code : 0, muted: v.muted }; }).filter((v) => v.w > 100 && v.h > 100);
  return { title: norm(document.title).slice(0, 200), host: location.hostname, path: location.pathname.slice(0, 120), scheme: location.protocol,
    status: nav ? (nav.responseStatus ?? null) : null, readyState: document.readyState, textLength: text.length, text: text.slice(0, 5000),
    frames: frames.slice(0, 30), videos: videos.slice(0, 4), resources: performance.getEntriesByType('resource').length,
    webdriver: navigator.webdriver, ua: navigator.userAgent, lang: navigator.language, iw: innerWidth, ih: innerHeight,
    pxCaptcha: !!document.querySelector('#px-captcha'), scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight };
})()`;

// Phrases, each with the name that goes in the notes. Checked against the title and the first 5000 characters of text.
const CHALLENGES: [RegExp, string][] = [
  [/confirm you.?re not a bot/i, "YouTube: \"Sign in to confirm you're not a bot\""],
  [/our systems have detected unusual traffic|unusual traffic from your computer network/i, 'Google: "unusual traffic", with a reCAPTCHA'],
  [/verify you are human|checking if the site connection is secure|needs to review the security of your connection|just a moment\.\.\./i, 'Cloudflare: a human check'],
  [/press (&|and) hold|robot or human\?/i, 'PerimeterX: "press and hold"'],
  [/enter the characters you see below|we just need to make sure you.?re not a robot|click the button below to continue shopping/i, 'Amazon: a robot check'],
  [/pardon our interruption/i, 'Imperva: "pardon our interruption"'],
  [/are you a robot|i.?m not a robot|complete the security check|security verification|human verification|captcha/i, 'a CAPTCHA'],
];
const BLOCKS: [RegExp, string][] = [
  [/blocked by network security/i, 'Reddit: "blocked by network security"'],
  [/access denied|you don.?t have permission to access/i, '"Access Denied"'],
  [/sorry, you have been blocked|you have been blocked|you are unable to access|error 10(0[56]|20)|request blocked|request could not be satisfied/i, 'a block page'],
  [/^403 forbidden$|^forbidden$|^error 403/i, '403'],
  [/too many requests/i, '429'],
];
const CHALLENGE_PATHS: [RegExp, string][] = [[/^\/sorry\//, 'Google /sorry/'], [/validatecaptcha/i, 'Amazon /errors/validateCaptcha'], [/\/blocked/i, 'a /blocked page']];
// A check shown in a frame the page puts in front of a person. The same hosts load invisibly on many sign-in pages, so size counts.
const CHALLENGE_FRAME = /challenges\.cloudflare\.com|recaptcha|hcaptcha\.com|captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com/;

export interface Call { verdict: Verdict; why: string }

export function classifyOne(p: Probe | null): Call {
  if (!p) return { verdict: 'unclear', why: 'no tab on screen to read' };
  if (!/^https?:$/.test(p.scheme)) return { verdict: 'block', why: `did not load: ${p.scheme}//${p.host}${p.path}` };
  // A notice that a form is guarded ("This page is protected by Google reCAPTCHA to ensure you're not a bot", Netflix's footer) isn't a check.
  const hay = `${p.title}\n${p.text}`.replace(/(this (site|page) is )?protected by (google )?recaptcha[^.]*\./gi, '');
  for (const [re, why] of CHALLENGES) if (re.test(hay)) return { verdict: 'challenge', why };
  if (p.pxCaptcha) return { verdict: 'challenge', why: 'PerimeterX: "press and hold"' };
  for (const [re, why] of CHALLENGE_PATHS) if (re.test(p.path)) return { verdict: re.source.includes('blocked') ? 'block' : 'challenge', why };
  const shown = p.frames.find((f) => CHALLENGE_FRAME.test(f.host + f.path) && f.w >= 250 && f.h >= 60);
  if (shown && p.textLength < 1500) return { verdict: 'challenge', why: `a check in a frame from ${shown.host}` };
  for (const [re, why] of BLOCKS) if (re.test(hay)) return { verdict: 'block', why };
  if (p.status === 403 || p.status === 429) return { verdict: p.textLength < 600 ? 'block' : 'unclear', why: `the page answered ${p.status}` };
  if (p.textLength < 200) return { verdict: 'unclear', why: `almost no text (${p.textLength} characters)` };
  return { verdict: 'pass', why: '' };
}

/** A visit's call from the read at load and the read after use. A check that cleared by itself counts as a pass, noted. */
export function classify(atLoad: Probe | null, afterUse: Probe | null, video: boolean): Call & { atLoad: Call; afterUse: Call } {
  const a = classifyOne(atLoad), b = classifyOne(afterUse);
  const out = (c: Call) => ({ ...c, atLoad: a, afterUse: b });
  if (video) {
    // A click can open a second player (Commons' overlay) rather than start the first, so any video counts. Against the furthest
    // one at load, so a video that was already playing then has to have gone on another 20 s.
    const t0 = Math.max(0, ...(atLoad?.videos ?? []).map((v) => v.t));
    const v1 = [...(afterUse?.videos ?? [])].filter((v) => !v.paused).sort((a, b) => b.t - a.t)[0] ?? afterUse?.videos[0];
    const played = !!v1 && !v1.paused && v1.t - t0 >= 20;
    if (b.verdict === 'challenge' || a.verdict === 'challenge') return out({ verdict: 'challenge', why: (b.verdict === 'challenge' ? b : a).why + (played ? ', though the video played' : ', and the video did not play') });
    if (b.verdict === 'block') return out(b);
    if (!played) return out({ verdict: 'unclear', why: `the video did not play (${v1 ? `paused=${v1.paused}, at ${v1.t} s, error ${v1.err}` : 'no video on the page'})` });
    return out({ verdict: 'pass', why: `played ${+(v1!.t - t0).toFixed(0)} s, ${v1!.vw}x${v1!.vh} in a ${v1!.w}x${v1!.h} player` });
  }
  if (b.verdict === 'pass' && a.verdict !== 'pass') return out({ verdict: 'pass', why: `at load: ${a.verdict}, ${a.why}; cleared by itself` });
  if (b.verdict === 'unclear' && a.verdict !== 'unclear') return out(a);
  return out(b);
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi;
// Where a site places the desk from its address: Maps' @lat,lng and a forecast's 30.27N 97.74W.
const LATLNG = /-?\d{1,3}\.\d{3,},\s?-?\d{1,3}\.\d{3,}|\b\d{1,2}\.\d{1,4}[NS] \d{1,3}\.\d{1,4}[EW]\b/g;
/** Some block and check pages print the visitor's address, and some sites where they place it. None goes into a file. */
export const redact = (s: string) => s.replace(IPV4, '[ip]').replace(IPV6, '[ip]').replace(LATLNG, '[location]');
