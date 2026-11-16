#!/usr/bin/env node
// The stand-in model (contract section 2): Anthropic's Messages API on 127.0.0.1, answering each model step from the
// task files' standIn scripts, in SSE exactly as desk-agent's AnthropicProvider reads it.
//
// It is stateless. The request's first user message names the task by its prompt (the runner's last line
// `canary: mmcanary-<hex>` taken off first), and the number of assistant turns after that message is the step. A `$re`
// input is the first capture group of a regex over an earlier step's tool result in the same request. Every `text` and
// `markdown` input it writes gets `\n<canary>` at its end. A prompt it doesn't know gets a plain text answer, so the
// run ends.
//
//   node standin/standin.mjs --tasks capability/tasks --port 0     prints: STANDIN http://127.0.0.1:<port>
//
// The same core is exported for the Java rig (as a child process) and for tests (in-process).
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMessage, buildSse, DEFAULT_MODEL, messageText, toolResultText, toolUses } from '../lib/anthropic.mjs';
import { CANARY_LINE } from '../lib/canary.mjs';
import { loadTasks } from '../lib/tasks.mjs';

export const UNKNOWN = "I don't know this task.";
export const UNRESOLVED = "I couldn't find what I needed in the tool results, so I stopped here.";
export const PAST_SCRIPT = 'Done.';
/** Inputs that take a whole number, so a `$re` for them gives a number unless it says `as`. */
const INT_KEYS = new Set(['offset', 'from', 'limit', 'inMinutes']);
/** What desk-agent's loop puts before a result the member approved, or one done under a switch. */
const LEADS = [/^Approved by the member\.\n/, /^Approved by the member, but it failed: /, /^Done without asking[^\n]*\n/];

class Unresolved extends Error {}

/** The tasks by prompt, and the prompts longest first for a match at the end of a longer message. */
export function indexTasks(tasks) {
  const byPrompt = new Map();
  for (const task of tasks) {
    if (typeof task?.prompt !== 'string') continue;
    if (byPrompt.has(task.prompt)) throw new Error(`two tasks have one prompt: ${byPrompt.get(task.prompt).id} and ${task.id}`);
    byPrompt.set(task.prompt, task);
  }
  const prompts = [...byPrompt.keys()].sort((a, b) => b.length - a.length);
  return { byPrompt, prompts, size: byPrompt.size };
}

/**
 * The task a user message names: its text with the canary line taken off, matched exactly, or as the end of a message
 * desk-agent joined to something before it (a summary of earlier turns goes first, joined with a blank line).
 */
export function matchPrompt(index, text) {
  if (typeof text !== 'string' || !text) return null;
  let body = text;
  let canary = null;
  const m = CANARY_LINE.exec(text);
  if (m) {
    canary = m[1];
    body = text.slice(0, m.index);
  }
  for (const candidate of [body, body.replace(/\s+$/, '')]) {
    const task = index.byPrompt.get(candidate);
    if (task) return { task, canary };
  }
  const trimmed = body.replace(/\s+$/, '');
  for (const prompt of index.prompts) {
    if (trimmed.endsWith(`\n${prompt}`)) return { task: index.byPrompt.get(prompt), canary };
  }
  return null;
}

/** The texts a regex is tried on, in order: the fenced JSON's content, the result without the loop's lead, the raw text. */
export function resultCandidates(text) {
  const out = [];
  let plain = text;
  for (const lead of LEADS) plain = plain.replace(lead, '');
  for (const line of plain.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j && typeof j.content === 'string' && typeof j.source === 'string') out.push(j.content);
    } catch {
      // not the fence's line
    }
  }
  out.push(plain);
  if (plain !== text) out.push(text);
  return out;
}

function resolveRe(spec, ctx, key) {
  const { step, call = 0, pattern, flags = '', as } = spec ?? {};
  const turn = ctx.assistants[step];
  if (!turn) throw new Unresolved(`no step ${step}`);
  const use = toolUses(turn)[call];
  if (!use) throw new Unresolved(`no call ${call} in step ${step}`);
  const text = ctx.results.get(use.id);
  if (typeof text !== 'string') throw new Unresolved(`no result for step ${step} call ${call}`);
  const re = new RegExp(pattern, flags.replace(/g/g, ''));
  for (const candidate of resultCandidates(text)) {
    const m = re.exec(candidate);
    if (m && m[1] !== undefined) {
      const wantInt = as === 'int' || (as === undefined && INT_KEYS.has(key));
      if (wantInt) {
        const n = Number(m[1]);
        if (!Number.isInteger(n)) throw new Unresolved(`not a whole number: step ${step}`);
        return n;
      }
      return m[1];
    }
  }
  throw new Unresolved(`no match in step ${step} call ${call}`);
}

function resolveValue(value, ctx, key) {
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx, key));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$re')) return resolveRe(value.$re, ctx, key);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx, k);
    return out;
  }
  return value;
}

function resolveText(text, ctx) {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map((part) => (typeof part === 'string' ? part : String(resolveValue(part, ctx, 'text')))).join('');
  return '';
}

/**
 * What the model says at this request: {task, step, blocks, canary, why}. Blocks are {type: 'text', text} and
 * {type: 'tool_use', name, input}.
 */
export function planStep(index, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let at = -1;
  let found = null;
  // The last user message that names a task, so an agent whose thread holds earlier tasks still answers the newest.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const m = matchPrompt(index, messageText(messages[i]));
    if (m) {
      at = i;
      found = m;
      break;
    }
  }
  if (!found) return { task: null, step: null, blocks: [{ type: 'text', text: UNKNOWN }], why: 'unknown' };
  const { task, canary } = found;
  const after = messages.slice(at + 1);
  const assistants = after.filter((m) => m?.role === 'assistant');
  const results = new Map();
  for (const m of after) {
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === 'tool_result') results.set(b.tool_use_id, toolResultText(b));
  }
  const step = assistants.length;
  const script = Array.isArray(task.standIn) ? task.standIn : [];
  if (step >= script.length) return { task, step, canary, blocks: [{ type: 'text', text: PAST_SCRIPT }], why: 'past_script' };
  const ctx = { assistants, results };
  const s = script[step];
  try {
    const blocks = [];
    if (s.text !== undefined) {
      const said = resolveText(s.text, ctx);
      if (said) blocks.push({ type: 'text', text: said });
    }
    for (const call of s.calls ?? []) {
      const input = resolveValue(call.input ?? {}, ctx);
      if (canary) {
        for (const k of ['text', 'markdown']) {
          if (typeof input[k] === 'string') input[k] = `${input[k]}\n${canary}`;
        }
      }
      blocks.push({ type: 'tool_use', name: call.name, input });
    }
    if (!blocks.length) blocks.push({ type: 'text', text: PAST_SCRIPT });
    return { task, step, canary, blocks, why: 'script' };
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    return { task, step, canary, blocks: [{ type: 'text', text: UNRESOLVED }], why: `unresolved: ${e.message}` };
  }
}

/** The stand-in's core, with no socket: answer(body) gives {status, headers, body} for POST /v1/messages. */
export function createStandIn({ tasks, dirs, key = null, models = [DEFAULT_MODEL], log = null, record = 0 } = {}) {
  const index = indexTasks(tasks ?? loadTasks(dirs ?? []));
  const recorded = [];
  const say = (line) => log && log(line);

  function answer(body) {
    const plan = planStep(index, body);
    if (record) {
      recorded.push({ body, plan });
      if (recorded.length > record) recorded.shift();
    }
    say(`step task=${plan.task?.id ?? '-'} step=${plan.step ?? '-'} ${plan.why}`);
    const model = typeof body?.model === 'string' && body.model ? body.model : models[0];
    if (body?.stream === false) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildMessage({ model, blocks: plan.blocks })) };
    }
    return { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: buildSse({ model, blocks: plan.blocks }) };
  }

  function modelsBody() {
    return JSON.stringify({
      data: models.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' })),
      has_more: false,
      first_id: models[0] ?? null,
      last_id: models.at(-1) ?? null,
    });
  }

  function authorized(headers) {
    if (!key) return true;
    return headers['x-api-key'] === key || headers.authorization === `Bearer ${key}`;
  }

  async function handle(req, res) {
    const send = (status, headers, body) => {
      res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (!authorized(req.headers)) {
        send(401, { 'content-type': 'application/json' }, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
        return;
      }
      if (req.method === 'GET' && path.endsWith('/v1/models')) {
        send(200, { 'content-type': 'application/json' }, modelsBody());
        return;
      }
      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        send(200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, tasks: index.size }));
        return;
      }
      if (req.method === 'POST' && path.endsWith('/v1/messages')) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 64 << 20) {
            send(413, { 'content-type': 'application/json' }, JSON.stringify({ type: 'error', error: { type: 'request_too_large' } }));
            return;
          }
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(400, { 'content-type': 'application/json' }, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'not JSON' } }));
          return;
        }
        const out = answer(body);
        send(out.status, out.headers, out.body);
        return;
      }
      send(404, { 'content-type': 'application/json' }, JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
    } catch (e) {
      say(`error ${e?.message}`);
      if (!res.headersSent) send(500, { 'content-type': 'application/json' }, JSON.stringify({ type: 'error', error: { type: 'api_error' } }));
    }
  }

  return { index, answer, handle, recorded, models };
}

/** Starts the stand-in on 127.0.0.1. Gives {url, port, standIn, close}. */
export async function startStandIn({ port = 0, host = '127.0.0.1', ...options } = {}) {
  const standIn = createStandIn(options);
  const server = createServer((req, res) => {
    standIn.handle(req, res);
  });
  server.keepAliveTimeout = 5000;
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, ok);
  });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    standIn,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}

async function main(argv) {
  const { parseArgs } = await import('../lib/args.mjs');
  const args = parseArgs(argv, { booleans: ['verbose'] });
  if (args.help) {
    process.stdout.write('node standin/standin.mjs --tasks <dir> [--tasks <dir>] [--port 0] [--key <key>] [--models a,b] [--verbose]\n');
    return;
  }
  const dirs = [].concat(args.tasks ?? []).filter((d) => typeof d === 'string');
  if (!dirs.length) {
    process.stderr.write('standin: give --tasks <dir>\n');
    process.exit(2);
  }
  const host = '127.0.0.1';
  const port = args.port === undefined ? 0 : Number(args.port);
  const models = typeof args.models === 'string' ? args.models.split(',').filter(Boolean) : [DEFAULT_MODEL];
  const log = args.verbose ? (line) => process.stderr.write(`standin ${line}\n`) : null;
  const started = await startStandIn({ dirs: dirs.map((d) => resolve(d)), port, host, key: typeof args.key === 'string' ? args.key : null, models, log });
  process.stdout.write(`STANDIN ${started.url}\n`);
  process.stderr.write(`standin: ${started.standIn.index.size} tasks\n`);
  const stop = () => started.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`standin: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
