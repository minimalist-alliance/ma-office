// Canonical JSON and the approval hash, as desk-agent's team/Canonical and the Agent app compute them: object keys
// sorted by UTF-16 code unit, no whitespace, strings escaped as JSON.stringify does, whole numbers only.
import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isInteger(value)) throw new Error('not a canonical value: a number with a fraction');
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`not a canonical value: ${typeof value}`);
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A card's sha256: the hash of {v: 1, agentId, runId, tool, context, payload} (API.md section 18). */
export function approvalHash({ agentId, runId, tool, context, payload }) {
  return sha256Hex(canonicalJson({ v: 1, agentId, runId, tool, context, payload }));
}
