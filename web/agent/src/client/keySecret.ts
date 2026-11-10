// A provider key on its way from the key field to the desk (design 9.5 step 1, ADR 0012). The plaintext sits in a
// module-private WeakMap, not on the object, so logging, JSON, React DevTools, a store or an error report sees
// only "[redacted]". Exactly one place reads it: the transport that writes `agent.key.add` to the desk's data
// channel (rpcAgentClient.ts). The caller wipes it as soon as the desk has answered.
//
// Honest limit: a JavaScript string can't be zeroed. Wiping drops the last reference, and the engine frees it
// when it likes. The field is cleared at once, and the key never reaches storage, a log or the network here.

const plaintext = new WeakMap<KeySecret, string>();

export const REDACTED = '[redacted]';

export class KeySecret {
  /** Whether the plaintext is still held. */
  get held(): boolean {
    return plaintext.has(this);
  }

  private constructor(text: string) {
    plaintext.set(this, text);
  }

  /** Takes a key as typed or pasted. Surrounding white space goes: a paste often brings a newline. */
  static fromText(text: string): KeySecret {
    return new KeySecret(text.trim());
  }

  /**
   * Takes what's in the field and empties it in the same task, so the key is never in the DOM after this
   * returns, whatever happens next.
   */
  static takeFrom(field: { value: string }): KeySecret {
    const secret = KeySecret.fromText(field.value);
    field.value = '';
    return secret;
  }

  /** The one way to the plaintext. Throws once wiped. Don't keep what `fn` gets. */
  withPlaintext<T>(fn: (key: string) => T): T {
    const text = plaintext.get(this);
    if (text === undefined) throw new Error('This key was already handed over and wiped');
    return fn(text);
  }

  /** Forgets the plaintext. Safe to call twice. */
  wipe(): void {
    plaintext.delete(this);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** Node's and Vitest's printers. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `KeySecret(${REDACTED})`;
  }
}

/** Why a key can't be right, before it goes anywhere. Mirrors task 04's `KeyRing.put` checks. */
export type KeyFormatProblem = 'empty' | 'length' | 'charset' | 'prefix';

export const KEY_MIN = 8;
export const KEY_MAX = 1024;

/** Task 04's rule: 8 to 1024 printable ASCII characters with no space, as it goes into an HTTP header. */
export function keyFormatProblem(secret: KeySecret, prefix: string): KeyFormatProblem | null {
  return secret.withPlaintext((key) => {
    if (!key) return 'empty';
    if (key.length < KEY_MIN || key.length > KEY_MAX) return 'length';
    for (let i = 0; i < key.length; i += 1) {
      const c = key.charCodeAt(i);
      if (c < 0x21 || c > 0x7e) return 'charset';
    }
    if (prefix && !key.startsWith(prefix)) return 'prefix';
    return null;
  });
}

/**
 * Whose key this is, by the longest `keyPrefix` it starts with, as desk-agent decides it (deskd API.md §11): `sk-ant-…` is
 * Anthropic's though it starts with OpenAI's `sk-`. Null for a key with no known prefix.
 */
export function keyOwner<P extends { keyPrefix: string }>(secret: KeySecret, providers: readonly P[]): P | null {
  return secret.withPlaintext((key) => {
    let best: P | null = null;
    for (const p of providers) if (p.keyPrefix && key.startsWith(p.keyPrefix) && p.keyPrefix.length > (best?.keyPrefix.length ?? 0)) best = p;
    return best;
  });
}

/** A key that belongs to another provider than the one picked, here or as the desk's `provider_mismatch`. */
export function providerMismatchMessage(ownerName: string | null): string {
  return ownerName
    ? `That’s a key from ${ownerName}. Pick ${ownerName} above and paste it again.`
    : 'That’s a key from another provider. Pick its provider above and paste it again.';
}

export function keyFormatMessage(problem: KeyFormatProblem, prefix: string): string {
  switch (problem) {
    case 'empty':
      return 'Paste a key first.';
    case 'length':
      return 'That doesn’t look like a whole key. Copy all of it again.';
    case 'charset':
      return 'A key has no spaces or line breaks. Copy it again from the console.';
    case 'prefix':
      return `Keys from this provider start with “${prefix}”. Check you picked the right provider.`;
  }
}
