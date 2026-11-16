// What rt-agent-tools.mjs and rt-agent-perf.mjs share for a real run: the capped key from SSM (never printed), the log's
// redaction, the bundle to load, a count on the desk's journal, and where results go. Nothing here runs on import.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { junitXml, redactor } from './pure.mjs';

const run = promisify(execFile);

/** The capped staging model key, as rt-lib reads a test user: SSM, decrypted, kept in memory only. */
export function readKey(param) {
  const v = execFileSync('aws', ['ssm', 'get-parameter', '--name', param, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (v.length < 20 || /\s/.test(v)) throw new Error('refusing: the key parameter doesn’t hold a key');
  return v;
}

/**
 * Every line rt-lib logs passes through this as well as its own scrub, so the key is out of the output even where a message
 * quotes a value. The line format is rt-lib's own, minus the mark column.
 */
export function installRedaction(lib, secrets) {
  const redact = redactor(secrets);
  const t0 = Date.now();
  lib.logConfig.line = (at, text) => console.log(`${((at - t0) / 1000).toFixed(3).padStart(9)} | ${redact(text)}`);
  return redact;
}

/** This checkout's `dist/release` in place of staging's bundle, or staging's own with MA_EXPECT_VERSION (or with no build here). */
export function bundleChoice(env) {
  const dist = new URL('../../../dist/release/', import.meta.url).pathname;
  if (env.MA_EXPECT_VERSION) return { expect: env.MA_EXPECT_VERSION, bundle: null, version: env.MA_EXPECT_VERSION };
  if (existsSync(`${dist}ma-release.json`)) {
    const release = JSON.parse(readFileSync(`${dist}ma-release.json`, 'utf8'));
    return { expect: null, bundle: { dist, release }, version: release.version };
  }
  return { expect: null, bundle: null, version: 'staging’s own' };
}

/** A count of lines holding `needle` in the desk's journal for the last `minutes`, over SSM, as rt-agent.mjs counts its key. Never a line. */
export async function journalCount(lib, needle, minutes) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(needle)) throw new Error('refusing: only a plain token is looked for');
  const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
  const aws = async (...a) => (await run('aws', a, { encoding: 'utf8', env, maxBuffer: 16 << 20 })).stdout;
  const command = `journalctl --since "-${Math.ceil(minutes)} min" --no-pager 2>/dev/null | grep -c -- "${needle}" || true`;
  const id = (await aws('ssm', 'send-command', '--instance-ids', lib.INSTANCE, '--document-name', 'AWS-RunShellScript', '--parameters', JSON.stringify({ commands: [command] }), '--query', 'Command.CommandId', '--output', 'text')).trim();
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    await lib.wait(1000);
    let inv;
    try {
      inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', lib.INSTANCE, '--output', 'json'));
    } catch {
      continue;
    }
    if (inv.Status === 'Success') return Number(inv.StandardOutputContent.trim());
    if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) throw new Error(`ssm ${inv.Status}`);
  }
  throw new Error('ssm timed out');
}

export function outDir(name) {
  const dir = new URL(`../../../test-results/real-desk/${name}/`, import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJunit(path, suite, results) {
  if (!path) return;
  writeFileSync(path, junitXml(suite, results));
}

/** The exact command, for a refusal's message. */
export const lockCommand = (script, extra = '', minutes = 45, withKey = true) =>
  `flock -w 1800 ~/work/.test-desk.lock timeout ${minutes}m nice -n 15 env MA_TEST_DESK_LOCK=held${withKey ? " MA_AGENT_TEST_KEY_PARAM=/ma/staging/<the key's parameter>" : ''} node tests/real-desk/${script}${extra ? ` ${extra}` : ''}`;

// ------------------------------------------------------------------ --model standin: the stand-in on the test desk, over SSM
//
// As the release agent did for the Nov 13 tools release (docs/sub-status/agent-tools-release-1113.md, "The real-desk proof"):
// standin_desk.py on the test desk's loopback under systemd-run as nobody, desk-agent pointed at it by its documented
// DESK_AGENT_ANTHROPIC_URL line (the env backed up first with its sha256), desk-agent restarted; and at the end the env put
// back byte for byte and checked, the stand-in stopped and removed, desk-agent restarted on its real providers. Only on the
// instance rt-lib names, after EC2 says it's the test desk.

export const STANDIN = {
  port: 18793,
  unit: 'rt-harness-standin',
  dir: '/run/rt-harness-standin',
  env: '/opt/ma/desk-agent/current/desk-agent.env',
  backup: '/root/rt-harness-desk-agent.env.bak',
  sha: '/root/rt-harness-desk-agent.env.sha',
  /** The release agent's own names: if its stand-in is still up, this one refuses. */
  otherUnit: 'rt-standin',
  otherBackup: '/root/rt-desk-agent.env.bak',
};

const awsEnv = () => ({ ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' });
const aws = async (...a) => (await run('aws', a, { encoding: 'utf8', env: awsEnv(), maxBuffer: 16 << 20 })).stdout;

/** One shell command as root on the test desk, over SSM: its status, output and error output. */
export async function ssmRun(lib, command, { timeoutS = 180 } = {}) {
  const id = (
    await aws('ssm', 'send-command', '--instance-ids', lib.INSTANCE, '--document-name', 'AWS-RunShellScript', '--timeout-seconds', '60', '--parameters', JSON.stringify({ commands: [command], executionTimeout: [String(timeoutS)] }), '--query', 'Command.CommandId', '--output', 'text')
  ).trim();
  const end = Date.now() + (timeoutS + 60) * 1000;
  while (Date.now() < end) {
    await lib.wait(1500);
    let inv;
    try {
      inv = JSON.parse(await aws('ssm', 'get-command-invocation', '--command-id', id, '--instance-id', lib.INSTANCE, '--output', 'json'));
    } catch {
      continue;
    }
    if (['Success', 'Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) return { status: inv.Status, out: inv.StandardOutputContent ?? '', err: inv.StandardErrorContent ?? '' };
  }
  return { status: 'NoAnswer', out: '', err: '' };
}

/** EC2's word that rt-lib's instance is the test desk: DeskKind test, and the desk id rt-lib allows. */
export async function confirmTestDesk(lib) {
  const tags = JSON.parse(await aws('ec2', 'describe-instances', '--instance-ids', lib.INSTANCE, '--query', 'Reservations[0].Instances[0].Tags', '--output', 'json')) ?? [];
  const tag = (name) => tags.find((t) => new RegExp(`(^|[:/])${name}$`, 'i').test(t.Key))?.Value ?? null;
  const kind = tag('DeskKind');
  const desk = tag('DeskId');
  if (kind !== 'test') throw new Error(`refusing: EC2 says this instance's DeskKind is ${JSON.stringify(kind)}, not test`);
  if (desk !== null && desk !== lib.ALLOWED) throw new Error('refusing: EC2 says this instance is another desk');
  return { kind, desk };
}

/** A file on the desk, in base64 chunks small enough for one SSM command each. */
export async function ssmWriteFile(lib, path, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const CHUNK = 24_000;
  for (let at = 0, n = 0; at < b64.length || n === 0; at += CHUNK, n += 1) {
    const r = await ssmRun(lib, `printf '%s' '${b64.slice(at, at + CHUNK)}' ${n === 0 ? '>' : '>>'} ${path}.b64`, { timeoutS: 60 });
    if (r.status !== 'Success') throw new Error(`writing ${path} on the desk: ${r.status}`);
  }
  const r = await ssmRun(lib, `base64 -d ${path}.b64 > ${path} && rm -f ${path}.b64 && chmod 644 ${path} && sha256sum ${path} | cut -c1-64`, { timeoutS: 60 });
  if (r.status !== 'Success') throw new Error(`writing ${path} on the desk: ${r.status}`);
  return r.out.trim();
}

/** The stand-in up: refuses if desk-agent.env already has the line, a backup is left, the port is busy, or a stand-in runs. */
export async function standinUp(lib, { key, scripts, py }) {
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(key)) throw new Error('refusing: a made-up key of letters, digits, - and _');
  const S = STANDIN;
  const pre = await ssmRun(
    lib,
    `E=${S.env}
test -f "$E" || { echo NO_ENV; exit 5; }
grep -q '^DESK_AGENT_ANTHROPIC_URL=' "$E" && { echo ENV_HAS_LINE; exit 4; }
test -e ${S.backup} && { echo BACKUP_LEFT; exit 6; }
test -e ${S.otherBackup} && { echo OTHER_BACKUP_LEFT; exit 6; }
ss -ltn | grep -q ':${S.port} ' && { echo PORT_BUSY; exit 3; }
systemctl is-active --quiet ${S.unit} && { echo UNIT_UP; exit 7; }
systemctl is-active --quiet ${S.otherUnit} && { echo OTHER_UNIT_UP; exit 7; }
rm -rf ${S.dir} && mkdir -p ${S.dir}/log && chmod 755 ${S.dir} && chown nobody:nogroup ${S.dir}/log && chmod 700 ${S.dir}/log
echo PRECHECK_OK`,
    { timeoutS: 60 },
  );
  if (!pre.out.includes('PRECHECK_OK')) throw new Error(`refusing to bring the stand-in up: ${pre.out.trim() || pre.status}`);
  await ssmWriteFile(lib, `${S.dir}/standin.py`, py);
  await ssmWriteFile(lib, `${S.dir}/scripts.json`, JSON.stringify(scripts));
  const up = await ssmRun(
    lib,
    `set -e
E=${S.env}
grep -q '^DESK_AGENT_ANTHROPIC_URL=' "$E" && { echo ENV_HAS_LINE; exit 4; }
systemd-run --unit=${S.unit} --uid=nobody --gid=nogroup -p RuntimeMaxSec=7200 /usr/bin/python3 -I ${S.dir}/standin.py ${S.port} ${S.dir}/scripts.json '${key}' ${S.dir}/log >/dev/null 2>&1
for i in $(seq 1 30); do curl -s -m 2 -H 'x-api-key: ${key}' http://127.0.0.1:${S.port}/v1/models | grep -q claude && break; sleep 0.5; done
cp -p "$E" ${S.backup}; sha256sum "$E" > ${S.sha}
echo 'DESK_AGENT_ANTHROPIC_URL=http://127.0.0.1:${S.port}' >> "$E"
systemctl restart desk-agent
for i in $(seq 1 90); do curl -s -m 2 --unix-socket /run/desk-agent/agent-admin.sock http://x/health | grep -q '"deskd":"connected"' && break; sleep 1; done
echo "AGENT $(curl -s -m 3 --unix-socket /run/desk-agent/agent-admin.sock http://x/health | grep -o '"deskd":"[a-z]*"')"
echo "MODELS $(curl -s -m 3 -H 'x-api-key: ${key}' http://127.0.0.1:${S.port}/v1/models | grep -o '"id": *"[^"]*"' | head -1)"
echo UP_OK`,
    { timeoutS: 180 },
  );
  if (!up.out.includes('UP_OK')) throw new Error(`the stand-in didn't come up: ${up.out.trim().slice(-300) || up.status}`);
  return { agent: /AGENT (.*)/.exec(up.out)?.[1] ?? '', models: /MODELS (.*)/.exec(up.out)?.[1] ?? '' };
}

/** Everything back, whatever state the up left: the env byte for byte (sha256 checked), the stand-in gone, desk-agent as it was. */
export async function standinDown(lib) {
  const S = STANDIN;
  const r = await ssmRun(
    lib,
    `E=${S.env}
CHANGED=0
if [ -f ${S.backup} ]; then cp -p ${S.backup} "$E"; if sha256sum -c ${S.sha} >/dev/null 2>&1; then echo ENV_SHA_OK; else echo ENV_SHA_BAD; fi; rm -f ${S.backup} ${S.sha}; CHANGED=1; else echo ENV_UNTOUCHED; fi
echo "LINES $(grep -c '^DESK_AGENT_ANTHROPIC_URL=' "$E")"
systemctl stop ${S.unit} >/dev/null 2>&1
systemctl reset-failed ${S.unit} >/dev/null 2>&1
rm -rf ${S.dir}
if [ $CHANGED = 1 ]; then systemctl restart desk-agent; for i in $(seq 1 90); do curl -s -m 2 --unix-socket /run/desk-agent/agent-admin.sock http://x/health | grep -q '"deskd":"connected"' && break; sleep 1; done; fi
echo "UNITS $(systemctl list-units --all --no-legend '${S.unit}*' | wc -l)"
echo "PORT $(ss -ltn | grep -c ':${S.port} ')"
echo "DIR $(test -e ${S.dir} && echo left || echo gone)"
echo "AGENT $(systemctl is-active desk-agent) $(curl -s -m 3 --unix-socket /run/desk-agent/agent-admin.sock http://x/health | grep -o '"deskd":"[a-z]*"')"
echo DOWN_DONE`,
    { timeoutS: 180 },
  );
  const out = r.out;
  const num = (k) => Number(new RegExp(`${k} (\\d+)`).exec(out)?.[1] ?? NaN);
  return {
    done: out.includes('DOWN_DONE'),
    env: out.includes('ENV_SHA_OK') ? 'restored, sha256 matched' : out.includes('ENV_SHA_BAD') ? 'RESTORED BUT THE SHA256 DIFFERS' : out.includes('ENV_UNTOUCHED') ? 'never changed' : 'unknown',
    envOk: out.includes('ENV_SHA_OK') || out.includes('ENV_UNTOUCHED'),
    lines: num('LINES'),
    units: num('UNITS'),
    port: num('PORT'),
    dirGone: out.includes('DIR gone'),
    agent: /AGENT (.*)/.exec(out)?.[1] ?? '',
    clean: out.includes('DOWN_DONE') && (out.includes('ENV_SHA_OK') || out.includes('ENV_UNTOUCHED')) && num('LINES') === 0 && num('UNITS') === 0 && num('PORT') === 0 && out.includes('DIR gone'),
  };
}

/** The stand-in's own source, to send to the desk. */
export const standinSource = () => readFileSync(new URL('./standin_desk.py', import.meta.url), 'utf8');

/** A made-up key in Anthropic's shape: the Keys tab takes it, the stand-in knows it, and no provider ever would. */
export const madeUpKey = (hex) => `sk-ant-harness-standin-${hex}`;

/**
 * The stand-in's whole life for one run: `up` once EC2 has said it's the test desk, and `down` once however the run ends (it
 * goes round again if anything is left), each said in the log. Both scripts use it the same way: `up` from the driver's
 * `beforeAgentWindow`, `down` at the end and from rt-lib's `afterClose` (a signal, the watchdog, a crash).
 */
export function standinLife(lib, { key, scripts }) {
  let went = false;
  let downing = null;
  return {
    get up() {
      return went;
    },
    async bringUp() {
      const desk = await confirmTestDesk(lib);
      lib.log(`EC2: DeskKind ${desk.kind}${desk.desk ? ', the allowed desk' : ''}`);
      went = true;
      const sc = scripts();
      const up = await standinUp(lib, { key, scripts: sc, py: standinSource() });
      lib.log(`stand-in up: ${Object.keys(sc.prompts).length} prompts; desk-agent ${up.agent}; ${up.models}`);
      return { prompts: Object.keys(sc.prompts).length, ...up };
    },
    down() {
      if (!went) return Promise.resolve(null);
      downing ??= (async () => {
        lib.log('stand-in: bringing it down');
        let d = await standinDown(lib).catch((e) => ({ clean: false, error: e.message }));
        if (!d.clean) d = await standinDown(lib).catch((e) => ({ clean: false, error: e.message }));
        lib.log(`stand-in down: env ${d.env}, ${d.lines} env lines, ${d.units} units, port ${d.port ? 'busy' : 'free'}, folder ${d.dirGone ? 'gone' : 'left'}, desk-agent ${d.agent}${d.error ? `, ${d.error}` : ''}`);
        return d;
      })();
      return downing;
    },
  };
}
