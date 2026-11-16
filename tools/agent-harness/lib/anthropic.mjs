// Anthropic's Messages API as desk-agent's AnthropicProvider speaks it: the SSE events a step streams back, and the
// request's messages read back into turns. Shared by the stand-in (which writes the events) and the fake rig (which
// reads them, as desk-agent does).
import { randomBytes } from 'node:crypto';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

function event(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function toolUseId() {
  return `toolu_${randomBytes(12).toString('hex')}`;
}

/**
 * One model step as SSE: message_start, a content block per text or tool_use (tool input as one input_json_delta),
 * message_delta with the stop reason, message_stop. Blocks: {type: 'text', text} or {type: 'tool_use', id?, name, input}.
 */
export function buildSse({ model = DEFAULT_MODEL, blocks = [], stopReason, inputTokens = 100, outputTokens = 20 }) {
  const stop = stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  let out = event('message_start', {
    message: {
      id: `msg_${randomBytes(12).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      out += event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      out += event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      out += event('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id ?? toolUseId(), name: block.name, input: {} },
      });
      out += event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      });
    }
    out += event('content_block_stop', { index });
  });
  out += event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } });
  out += event('message_stop', {});
  return out;
}

/** The same step as a whole message, for a request with stream false. */
export function buildMessage({ model = DEFAULT_MODEL, blocks = [], stopReason }) {
  const stop = stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return {
    id: `msg_${randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: blocks.map((b) =>
      b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id ?? toolUseId(), name: b.name, input: b.input ?? {} },
    ),
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

/** SSE text into its events, in order: [{event, data}]. */
export function sseEvents(text) {
  const events = [];
  for (const chunk of String(text).split(/\r?\n\r?\n/)) {
    if (!chunk.trim()) continue;
    let name = null;
    const data = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    events.push({ event: name, data: JSON.parse(data.join('\n')) });
  }
  return events;
}

/** A step's stream read as desk-agent reads it: its text, its tool calls in order, the stop reason and the model. */
export function parseSse(text) {
  let model = null;
  let stopReason = null;
  let said = '';
  let stopped = false;
  const open = new Map();
  const calls = [];
  for (const { data } of sseEvents(text)) {
    switch (data.type) {
      case 'message_start':
        model = data.message?.model ?? model;
        break;
      case 'content_block_start':
        if (data.content_block?.type === 'tool_use') {
          open.set(data.index, { id: data.content_block.id, name: data.content_block.name, json: '' });
        }
        break;
      case 'content_block_delta':
        if (data.delta?.type === 'input_json_delta') {
          const pending = open.get(data.index);
          if (pending) pending.json += data.delta.partial_json ?? '';
        } else if (data.delta?.type === 'text_delta') {
          said += data.delta.text ?? '';
        }
        break;
      case 'content_block_stop': {
        const done = open.get(data.index);
        if (done) {
          open.delete(data.index);
          let input;
          let malformed = false;
          try {
            input = done.json.trim() ? JSON.parse(done.json) : {};
            if (!input || typeof input !== 'object' || Array.isArray(input)) malformed = true;
          } catch {
            malformed = true;
          }
          calls.push({ id: done.id, name: done.name, input: malformed ? {} : input, malformed });
        }
        break;
      }
      case 'message_delta':
        stopReason = data.delta?.stop_reason ?? stopReason;
        break;
      case 'message_stop':
        stopped = true;
        break;
      case 'error':
        throw new Error(`the stream said error: ${data.error?.type}`);
      default:
        break;
    }
  }
  if (!stopped) throw new Error('the stream ended without message_stop');
  return { model, text: said, calls, stopReason };
}

/** A message's text: a string content, or its text blocks joined as desk-agent joins them. */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

export function toolUses(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use');
}

/** A tool_result block's text: its content as a string, or its text blocks joined. */
export function toolResultText(block) {
  const content = block?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}
