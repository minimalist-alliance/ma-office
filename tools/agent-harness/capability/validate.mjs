#!/usr/bin/env node
// Checks every task file against the format (contract section 3): ids and prompts unique, the area its folder's, every
// stand-in tool in ToolRegistry's list with input its schema takes, a policy that covers every stand-in call, checks
// well formed, and every `$re` naming an earlier step.
//
//   node capability/validate.mjs [--tasks <dir>]     prints each problem; exits 1 if there is one
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { CHECK_KINDS } from '../lib/checks.mjs';
import { AREAS, HARNESS, TASKS_ROOT, taskFiles } from '../lib/tasks.mjs';
import { GATED } from '../lib/violations.mjs';

export const REGISTRY_JAVA = resolve(HARNESS, '../../services/desk-agent/src/main/java/com/minimalistalliance/desk/agent/tool/ToolRegistry.java');

/** The tool names ToolRegistry declares, read from its source. */
export function registryTools(path = REGISTRY_JAVA) {
  if (!existsSync(path)) return null;
  const src = readFileSync(path, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/\b(?:hosted|own)\(d,(?: s,)? "([a-z_]+)"/g)) names.add(m[1]);
  for (const m of src.matchAll(/new ToolDecl\("([a-z_]+)"/g)) names.add(m[1]);
  for (const m of src.matchAll(/"(propose_[a-z_]+)"/g)) names.add(m[1]);
  return names;
}

/** The input each tool takes, as ToolRegistry declares it: property types, and which are required. */
export const SCHEMAS = {
  files_list: { props: { path: 'string' }, required: [] },
  files_search: { props: { q: 'string', under: 'string' }, required: ['q'] },
  files_read: { props: { path: 'string', offset: 'int' }, required: ['path'] },
  files_write: { props: { path: 'string', text: 'string', replace: 'boolean' }, required: ['path', 'text'] },
  files_mkdir: { props: { path: 'string' }, required: ['path'] },
  files_move: { props: { from: 'string', to: 'string' }, required: ['from', 'to'] },
  files_trash: { props: { path: 'string' }, required: ['path'] },
  notebook_search: { props: { query: 'string', notebookId: 'string', tabId: 'string', limit: 'int' }, required: ['query'] },
  notebook_list: { props: { tabId: 'string', from: 'int' }, required: [] },
  notebook_read: { props: { pageId: 'string', from: 'int' }, required: ['pageId'] },
  notebook_write: { props: { pageId: 'string', new: 'page', op: 'op', markdown: 'string', find: 'string' }, required: ['op', 'markdown'] },
  notebook_trash: { props: { pageId: 'string' }, required: ['pageId'] },
};

/** Inputs that name a place a tool writes or reads: they must be in Harness. */
const PLACES = { files_list: ['path'], files_search: ['under'], files_read: ['path'], files_write: ['path'], files_mkdir: ['path'], files_move: ['from', 'to'], files_trash: ['path'] };

const isRe = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, '$re');
const inHarness = (p) => p === 'Harness' || p.startsWith('Harness/');

function checkRe(spec, at, steps, where, problems) {
  const r = spec?.$re;
  if (!r || typeof r !== 'object') return problems.push(`${where}: $re is not an object`);
  if (!Number.isInteger(r.step) || r.step < 0 || r.step >= at) return problems.push(`${where}: $re step ${r.step} is not an earlier step`);
  const calls = steps[r.step]?.calls ?? [];
  const c = r.call ?? 0;
  if (!Number.isInteger(c) || c < 0 || c >= calls.length) return problems.push(`${where}: $re call ${c} is not a call of step ${r.step}`);
  if (typeof r.pattern !== 'string') return problems.push(`${where}: $re has no pattern`);
  try {
    const rx = new RegExp(`${r.pattern}|`, r.flags ?? '');
    if (rx.exec('').length < 2) problems.push(`${where}: $re pattern has no capture group`);
  } catch (e) {
    problems.push(`${where}: $re pattern doesn't compile: ${e.message}`);
  }
  if (r.as !== undefined && !['int', 'string'].includes(r.as)) problems.push(`${where}: $re as must be int or string`);
  for (const k of Object.keys(r)) if (!['step', 'call', 'pattern', 'flags', 'as'].includes(k)) problems.push(`${where}: $re has an unknown key ${k}`);
}

function checkType(type, value, where, problems, ctx) {
  if (isRe(value)) return checkRe(value, ctx.at, ctx.steps, where, problems);
  switch (type) {
    case 'string':
      if (typeof value !== 'string') problems.push(`${where}: not a string`);
      break;
    case 'int':
      if (!Number.isInteger(value) || value < 0) problems.push(`${where}: not a whole number`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${where}: not a boolean`);
      break;
    case 'op':
      if (!['create', 'append', 'replace_text'].includes(value)) problems.push(`${where}: op is not create, append or replace_text`);
      break;
    case 'page':
      if (!value || typeof value !== 'object') {
        problems.push(`${where}: not an object`);
        break;
      }
      for (const k of Object.keys(value)) if (!['tabId', 'title'].includes(k)) problems.push(`${where}: unknown key ${k}`);
      checkType('string', value.tabId, `${where}.tabId`, problems, ctx);
      checkType('string', value.title, `${where}.title`, problems, ctx);
      break;
    default:
      problems.push(`${where}: unknown type ${type}`);
  }
}

function checkCall(c, at, steps, where, problems, registry) {
  if (!c || typeof c.name !== 'string') return problems.push(`${where}: a call has no name`);
  if (registry && !registry.has(c.name)) problems.push(`${where}: ${c.name} isn't in ToolRegistry`);
  const schema = SCHEMAS[c.name];
  if (!schema) return problems.push(`${where}: ${c.name} has no input schema here`);
  const input = c.input ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) return problems.push(`${where}: input is not an object`);
  for (const k of Object.keys(input)) if (!schema.props[k]) problems.push(`${where}: ${c.name} takes no ${k}`);
  for (const k of schema.required) if (input[k] === undefined) problems.push(`${where}: ${c.name} needs ${k}`);
  for (const [k, v] of Object.entries(input)) if (schema.props[k]) checkType(schema.props[k], v, `${where}.${k}`, problems, { at, steps });
  for (const k of PLACES[c.name] ?? []) {
    if (typeof input[k] === 'string' && !inHarness(input[k])) problems.push(`${where}: ${c.name} ${k} is outside Harness`);
  }
  if (c.name === 'notebook_write') {
    if (input.op === 'create' && (input.new === undefined || input.pageId !== undefined)) problems.push(`${where}: create takes new, not pageId`);
    if (input.op !== 'create' && (input.pageId === undefined || input.new !== undefined)) problems.push(`${where}: ${input.op} takes pageId, not new`);
    if ((input.op === 'replace_text') !== (input.find !== undefined)) problems.push(`${where}: find goes with replace_text only`);
  }
}

function checkChecks(task, where, problems, tabs) {
  if (!Array.isArray(task.checks) || !task.checks.length) return problems.push(`${where}: no checks`);
  const allowed = new Set(task.policy?.tools ?? []);
  const strings = (v) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
  task.checks.forEach((c, i) => {
    const at = `${where} check ${i}`;
    if (!c || !CHECK_KINDS.includes(c.kind)) return problems.push(`${at}: unknown kind ${c?.kind}`);
    if (!strings(c.contains) || !strings(c.notContains)) problems.push(`${at}: contains and notContains are lists of strings`);
    switch (c.kind) {
      case 'file':
      case 'noFile':
        if (typeof c.path !== 'string' || !c.path.startsWith('Harness/')) problems.push(`${at}: path must be under Harness/`);
        if (c.equals !== undefined && typeof c.equals !== 'string') problems.push(`${at}: equals is a string`);
        if (c.kind === 'file' && c.path?.endsWith('/') && (c.equals !== undefined || c.contains || c.notContains)) problems.push(`${at}: a folder has no text`);
        break;
      case 'trashed':
        if (typeof c.name !== 'string' || !c.name || c.name.includes('/')) problems.push(`${at}: name is a file's name`);
        if (c.value !== undefined && typeof c.value !== 'boolean') problems.push(`${at}: value is a boolean`);
        break;
      case 'page':
      case 'noPage':
        if (typeof c.title !== 'string' || !c.title) problems.push(`${at}: no title`);
        if (!tabs.has(c.tab)) problems.push(`${at}: tab ${c.tab} isn't one the setup makes`);
        if (c.trashed !== undefined && typeof c.trashed !== 'boolean') problems.push(`${at}: trashed is a boolean`);
        break;
      case 'reply':
        if (c.state !== undefined && !['done', 'failed', 'stopped'].includes(c.state)) problems.push(`${at}: state is done, failed or stopped`);
        break;
      case 'cards':
        if (!Array.isArray(c.tools)) problems.push(`${at}: tools is a list`);
        for (const t of c.tools ?? []) {
          if (!GATED.has(t)) problems.push(`${at}: ${t} never asks, so it has no card`);
          if (!allowed.has(t)) problems.push(`${at}: ${t} isn't in the policy`);
        }
        break;
      case 'untrusted':
        if (typeof c.value !== 'boolean') problems.push(`${at}: value is a boolean`);
        break;
      default:
        break;
    }
  });
}

/** Problems with one task: a list of strings. */
export function validateTask(task, { area, file, registry } = {}) {
  const problems = [];
  const where = task?.id ?? file ?? '?';
  if (!task || typeof task !== 'object') return [`${where}: not an object`];
  if (typeof task.id !== 'string' || !/^[a-z]+-\d{3}$/.test(task.id)) problems.push(`${where}: id must be <area>-NNN`);
  if (area && task.area !== area) problems.push(`${where}: area ${task.area} isn't its folder's (${area})`);
  if (area && typeof task.id === 'string' && !task.id.startsWith(`${area}-`)) problems.push(`${where}: id doesn't start with its area`);
  if (file && basename(file) !== `${task.id}.json`) problems.push(`${where}: file name isn't ${task.id}.json`);
  if (typeof task.title !== 'string' || !task.title.trim()) problems.push(`${where}: no title`);
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) problems.push(`${where}: no prompt`);
  else if (/canary:/i.test(task.prompt) || task.prompt !== task.prompt.trim()) problems.push(`${where}: the prompt has a canary line or spaces at an end`);
  const known = ['id', 'area', 'title', 'prompt', 'setup', 'approve', 'checks', 'policy', 'standIn'];
  for (const k of Object.keys(task)) if (!known.includes(k)) problems.push(`${where}: unknown key ${k}`);

  // The world.
  const setup = task.setup ?? {};
  const tabs = new Set(['Harness']);
  for (const [p, text] of Object.entries(setup.files ?? {})) {
    if (!p.startsWith('Harness/')) problems.push(`${where}: setup file ${p} is outside Harness/`);
    if (p.endsWith('/') ? text !== null : typeof text !== 'string') problems.push(`${where}: setup ${p} must be ${p.endsWith('/') ? 'null (a folder)' : 'text'}`);
  }
  for (const [i, pg] of (setup.notebook ?? []).entries()) {
    if (typeof pg?.tab !== 'string' || !pg.tab.startsWith('Harness')) problems.push(`${where}: setup page ${i} is in a tab not named Harness...`);
    else tabs.add(pg.tab);
    if (typeof pg?.title !== 'string' || !pg.title) problems.push(`${where}: setup page ${i} has no title`);
    if (typeof pg?.markdown !== 'string') problems.push(`${where}: setup page ${i} has no markdown`);
  }

  // Approvals.
  const a = task.approve ?? 'all';
  const okApprove =
    a === 'all' ||
    a === 'none' ||
    (a && typeof a === 'object' && !Array.isArray(a) &&
      ((typeof a.declineNote === 'string' && a.declineNote.length >= 1 && a.declineNote.length <= 500 && Object.keys(a).length === 1) ||
        (Array.isArray(a.decline) && a.decline.every((t) => GATED.has(t)) && (a.note === undefined || typeof a.note === 'string') && Object.keys(a).every((k) => ['decline', 'note'].includes(k)))));
  if (!okApprove) problems.push(`${where}: approve is "all", "none", {decline: [tools], note?} or {declineNote}`);

  // The policy.
  const policy = task.policy?.tools;
  if (!Array.isArray(policy) || !policy.length) problems.push(`${where}: policy.tools is a list of tools`);
  for (const t of policy ?? []) if (registry && !registry.has(t)) problems.push(`${where}: policy tool ${t} isn't in ToolRegistry`);

  // The stand-in's script.
  const steps = task.standIn;
  if (!Array.isArray(steps) || !steps.length) problems.push(`${where}: standIn is a list of steps`);
  else {
    const used = new Set();
    steps.forEach((s, at) => {
      const sw = `${where} step ${at}`;
      if (!s || typeof s !== 'object') return problems.push(`${sw}: not an object`);
      for (const k of Object.keys(s)) if (!['calls', 'text'].includes(k)) problems.push(`${sw}: unknown key ${k}`);
      if (s.calls === undefined && s.text === undefined) problems.push(`${sw}: has neither calls nor text`);
      if (s.calls !== undefined && (!Array.isArray(s.calls) || !s.calls.length)) problems.push(`${sw}: calls is a non-empty list`);
      if (s.text !== undefined) {
        const parts = Array.isArray(s.text) ? s.text : [s.text];
        parts.forEach((p, j) => {
          if (typeof p === 'string') return;
          if (isRe(p)) checkRe(p, at, steps, `${sw} text ${j}`, problems);
          else problems.push(`${sw}: text is a string or a list of strings and $re`);
        });
      }
      (s.calls ?? []).forEach((c, j) => {
        checkCall(c, at, steps, `${sw} call ${j}`, problems, registry);
        if (c?.name) used.add(c.name);
      });
    });
    const last = steps.at(-1);
    if (last && (last.calls !== undefined || last.text === undefined)) problems.push(`${where}: the last step must be text alone, so the run ends`);
    for (const t of used) if (!(policy ?? []).includes(t)) problems.push(`${where}: policy doesn't cover ${t}`);
    for (const t of policy ?? []) if (!used.has(t)) problems.push(`${where}: policy has ${t}, which the stand-in never calls (keep it tight)`);
  }
  checkChecks(task, where, problems, tabs);
  return problems;
}

/** Every task under a root: {tasks, problems}. */
export function validateAll(root = TASKS_ROOT, { areas = AREAS, registry = registryTools() } = {}) {
  const problems = [];
  if (!registry) problems.push(`ToolRegistry.java wasn't found at ${REGISTRY_JAVA}`);
  const ids = new Map();
  const prompts = new Map();
  let count = 0;
  for (const file of taskFiles(root)) {
    const rel = relative(root, file);
    const area = basename(dirname(file));
    if (!areas.includes(area)) {
      problems.push(`${rel}: ${area} isn't an area the runners know (lib/tasks.mjs AREAS)`);
      continue;
    }
    let task;
    try {
      task = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`${rel}: not JSON: ${e.message}`);
      continue;
    }
    count++;
    problems.push(...validateTask(task, { area, file, registry: registry ?? null }));
    if (ids.has(task.id)) problems.push(`${rel}: id ${task.id} is also ${ids.get(task.id)}`);
    else ids.set(task.id, rel);
    if (prompts.has(task.prompt)) problems.push(`${rel}: its prompt is also ${prompts.get(task.prompt)}'s`);
    else prompts.set(task.prompt, rel);
  }
  return { count, problems };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.tasks === 'string' ? resolve(args.tasks) : TASKS_ROOT;
  const { count, problems } = validateAll(root);
  for (const p of problems) process.stdout.write(`${p}\n`);
  const byArea = AREAS.map((a) => `${a} ${existsSync(join(root, a)) ? taskFiles(join(root, a)).length : 0}`).join(', ');
  process.stdout.write(`${count} tasks (${byArea}), ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
