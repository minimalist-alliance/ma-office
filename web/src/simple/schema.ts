// `deskd`'s closed MDoc schema (API.md section 14), held to on the way in (security review T47O-1). `mdoc-schema.json`
// is `services/deskd/src/test/resources/minified/mdoc-schema.json` on `sub/minified-stage-a`, copied unchanged; deskd's
// own `MDocSchemaTest` holds what it sends to the same file, so anything that doesn't fit isn't deskd's and is dropped.
//
// The check is shallow, one object at a time: its own fields are all named for it, of their type, the required ones
// there, and each enum's word its own. The parser checks every nested part and run where it reads it, so one bad run
// drops that run, not its paragraph. Pure.
import schema from './mdoc-schema.json';

type Fields = Record<string, string>;

interface Schema {
  head: Fields;
  blocks: Record<string, Fields>;
  runs: Record<string, Fields>;
  parts: Record<string, Fields>;
  enums: Record<string, readonly string[]>;
}

const S = schema as unknown as Schema;

interface Field {
  type: string;
  required: boolean;
}

interface Spec {
  /** The enum keys' first word: `head`, a block's `t`, a run's `r` or a part's name. */
  ctx: string;
  fields: Map<string, Field>;
  /** The field that names the kind, `t` or `r`, which isn't in the schema's list. */
  tag: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = <T>(table: Record<string, T>, key: string): boolean => Object.hasOwn(table, key);

function compile(ctx: string, fields: Fields, tag: string | null): Spec {
  const out = new Map<string, Field>();
  for (const [k, type] of Object.entries(fields)) out.set(k.replace(/!$/, ''), { type, required: k.endsWith('!') });
  return { ctx, fields: out, tag };
}

const specs = new Map<string, Spec | null>();

function spec(where: string): Spec | null {
  if (specs.has(where)) return specs.get(where) ?? null;
  const [kind, name = ''] = where.split(':') as [string, string?];
  let s: Spec | null = null;
  if (kind === 'head') s = compile('head', S.head, null);
  else if (kind === 'block' && has(S.blocks, name)) s = compile(name, S.blocks[name] as Fields, 't');
  else if (kind === 'run' && has(S.runs, name)) s = compile(name, S.runs[name] as Fields, 'r');
  else if (kind === 'part' && has(S.parts, name)) s = compile(name, S.parts[name] as Fields, null);
  specs.set(where, s);
  return s;
}

/** A value of a schema type, at this object's level only: a list is a list, a part an object, a run a string or an object. */
function typed(v: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'int':
      return typeof v === 'number' && Number.isSafeInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'bool':
      return typeof v === 'boolean';
    case 'run':
      return typeof v === 'string' || isObj(v);
    case 'runs':
    case 'blocks':
    case 'strings':
    case 'cells':
    case 'menus':
    case 'cards':
    case 'tracks':
      return Array.isArray(v);
    default:
      if (type.startsWith('map:')) return isObj(v);
      if (type.startsWith('list:')) return Array.isArray(v);
      // A type this copy of the schema doesn't know: not what deskd sends, so it doesn't fit.
      return false;
  }
}

/**
 * True when `v` is exactly what the schema allows `where` to be: `head`, `block:<t>`, `run:<r>` or `part:<name>`.
 * `loose` names enum fields the caller reads itself, failing closed on a word it doesn't know (a field's `kind`, a
 * sensitive run's `kind`), so an unknown word there is the caller's to handle rather than a reason to drop the whole.
 */
export function fits(where: string, v: unknown, loose?: ReadonlySet<string>): v is Record<string, unknown> {
  const s = spec(where);
  if (!s || !isObj(v)) return false;
  for (const [name, f] of s.fields) if (f.required && !Object.hasOwn(v, name)) return false;
  for (const name of Object.keys(v)) {
    if (name === s.tag) continue;
    const f = s.fields.get(name);
    if (!f || !typed(v[name], f.type)) return false;
    const key = `${s.ctx}.${name}`;
    if (has(S.enums, key) && !loose?.has(name) && !(S.enums[key] as readonly string[]).includes(v[name] as string)) return false;
  }
  return true;
}

/** The schema's words for one enum, such as `field.kind`: for the parser's own tables and the contract test. */
export const enumWords = (key: string): readonly string[] => (has(S.enums, key) ? (S.enums[key] as readonly string[]) : []);

/** Every block kind and run kind the schema names, for the contract test. */
export const blockKinds = (): string[] => Object.keys(S.blocks);
export const runKinds = (): string[] => Object.keys(S.runs);
