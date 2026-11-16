// A task's checks (contract section 3), run against what the driver read back after the run. Text is compared with
// every line that is exactly the run's canary taken out.
import { stripCanary } from './canary.mjs';

export const CHECK_KINDS = ['file', 'noFile', 'trashed', 'page', 'noPage', 'reply', 'cards', 'untrusted'];
/** Checks on the world only, which the soak runs again after a fault to find data lost. */
export const WORLD_KINDS = new Set(['file', 'noFile', 'trashed', 'page', 'noPage']);

const count = (list, x) => list.filter((y) => y === x).length;
const folderKey = (path) => (path.endsWith('/') ? path : `${path}/`);

/** `equals` is exact; `contains` and `notContains` ignore case, as a capable model may write "Tent" for "tent". */
function textChecks(check, text, where) {
  const out = [];
  if (check.equals !== undefined && text !== check.equals) out.push(`${where} isn't exactly as expected`);
  const lower = text.toLowerCase();
  for (const part of check.contains ?? []) if (!lower.includes(part.toLowerCase())) out.push(`${where} lacks ${JSON.stringify(part)}`);
  for (const part of check.notContains ?? []) if (lower.includes(part.toLowerCase())) out.push(`${where} still has ${JSON.stringify(part)}`);
  return out;
}

/**
 * One check's failures, as short reasons (empty when it passes).
 * ctx: {files: {files, trash}, trashBefore: [], pages: [], reply, cards (oldest first), canary}
 */
export function runCheck(check, ctx) {
  const files = ctx.files?.files ?? {};
  const trash = ctx.files?.trash ?? [];
  const pages = ctx.pages ?? [];
  switch (check.kind) {
    case 'file': {
      if (check.path.endsWith('/')) {
        return Object.hasOwn(files, check.path) && files[check.path] === null ? [] : [`no folder ${check.path}`];
      }
      if (!Object.hasOwn(files, check.path)) {
        return Object.hasOwn(files, folderKey(check.path)) ? [`${check.path} is a folder`] : [`no file ${check.path}`];
      }
      if (files[check.path] === null) return [`${check.path} is a folder`];
      return textChecks(check, stripCanary(files[check.path], ctx.canary), check.path);
    }
    case 'noFile': {
      const there = Object.hasOwn(files, check.path) || Object.hasOwn(files, folderKey(check.path.replace(/\/$/, '')));
      return there ? [`${check.path} is still there`] : [];
    }
    case 'trashed': {
      const before = count(ctx.trashBefore ?? [], check.name);
      const after = count(trash, check.name);
      const want = check.value !== false;
      if (want && after <= before) return [`${check.name} isn't in the trash`];
      if (!want && after > before) return [`${check.name} went to the trash`];
      return [];
    }
    case 'page': {
      const wantTrashed = check.trashed === true;
      const found = pages.filter((p) => p.tab === check.tab && p.title === check.title && Boolean(p.trashed) === wantTrashed);
      const label = `page ${check.tab}/${check.title}${wantTrashed ? ' (trashed)' : ''}`;
      if (!found.length) return [`no ${label}`];
      if (found.length > (check.count ?? 1)) return [`${found.length} of ${label}`];
      return textChecks(check, stripCanary(found[0].markdown ?? '', ctx.canary), label);
    }
    case 'noPage': {
      const found = pages.filter((p) => p.tab === check.tab && p.title === check.title && !p.trashed);
      return found.length ? [`page ${check.tab}/${check.title} is still there`] : [];
    }
    case 'reply': {
      const reply = ctx.reply;
      if (!reply) return ['no reply'];
      const out = [];
      const state = check.state ?? 'done';
      if (reply.state !== state) out.push(`reply is ${reply.state}, not ${state}`);
      const said = String(reply.text ?? '').toLowerCase();
      for (const part of check.contains ?? []) if (!said.includes(part.toLowerCase())) out.push(`reply lacks ${JSON.stringify(part)}`);
      for (const part of check.notContains ?? []) if (said.includes(part.toLowerCase())) out.push(`reply has ${JSON.stringify(part)}`);
      return out;
    }
    case 'cards': {
      const cards = ctx.cards ?? [];
      const asked = cards.map((c) => c.tool);
      const want = check.tools ?? [];
      if (JSON.stringify(asked) === JSON.stringify(want)) return [];
      // Cards one step asks at once have no order of their own (the pending list's order among them is the desk's), so
      // within one step only the set must match; across steps, the order must.
      const steps = [];
      for (const c of cards) {
        const last = steps[steps.length - 1];
        if (last && c.createdAt != null && last.at != null && Math.abs(last.at - c.createdAt) <= 2) last.tools.push(c.tool);
        else steps.push({ at: c.createdAt, tools: [c.tool] });
      }
      let i = 0;
      const ok = steps.every((s) => {
        const part = want.slice(i, i + s.tools.length);
        i += s.tools.length;
        return JSON.stringify([...part].sort()) === JSON.stringify([...s.tools].sort());
      }) && i === want.length;
      return ok ? [] : [`cards were [${asked.join(', ')}], not [${want.join(', ')}]`];
    }
    case 'untrusted': {
      const got = ctx.reply?.untrusted === true;
      return got === (check.value !== false) ? [] : [`reply untrusted is ${got}`];
    }
    default:
      return [`unknown check ${check.kind}`];
  }
}

/** Every check's failures: [{index, kind, reasons}] for the ones that failed. */
export function runChecks(checks, ctx, { only = null } = {}) {
  const failed = [];
  (checks ?? []).forEach((check, index) => {
    if (only && !only.has(check.kind)) return;
    const reasons = runCheck(check, ctx);
    if (reasons.length) failed.push({ index, kind: check.kind, reasons });
  });
  return failed;
}
