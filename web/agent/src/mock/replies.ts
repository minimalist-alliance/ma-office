// Canned replies. The mock calls no model, and says so.

const LONG = [
  'Here is a longer answer, so you can watch a reply stream in at full speed.',
  'A real reply arrives a few words at a time from the provider, through desk-agent and deskd, over this desk’s own encrypted connection. Nothing in between can read it, and the platform never sees it.',
  'Each reply is badged with the provider and model that wrote it, because an agent’s model can change in the middle of a thread. If you hide the badges, the footer still says who answered.',
  'Under every reply is what it cost, estimated from the tokens the provider reported. Before each call the desk reserves the most it could cost, and refuses if that would pass any of your limits, so a runaway task stops before it spends.',
  'Your key stays on the desk. It went there once, over the same encrypted connection, and this window kept no copy. To revoke it for good, revoke it in the provider’s console too.',
  'That’s the end of the long answer.',
].join('\n\n');

export function cannedReply(agentName: string, providerName: string, text: string): string {
  const t = text.toLowerCase();
  if (/^(hi|hello|hey|morning)\b/.test(t)) {
    return `Hello. I’m ${agentName}, on this desk only. This is the demo, so ${providerName} isn’t being called. Ask me anything and you’ll see how a reply streams and what it costs.`;
  }
  if (/long|essay|stream/.test(t)) return LONG;
  if (/what can you|help|do for/.test(t)) {
    return 'In this demo I can stream a reply, show its cost and stop when a limit says so. On a real desk, once tools arrive, I’ll work with this desk’s notebook, browser and chat, and ask before anything leaves the desk.';
  }
  if (/usage|limit|spend|cost|budget/.test(t)) {
    return 'Each reply shows its estimated cost underneath. Your limits are under Usage: per day, week and month for me, a monthly cap for the whole desk, and a cap on each run. Set a spend limit in the provider’s console too: it’s the real backstop.';
  }
  return `I’m a mock agent, so ${providerName} isn’t being called. With your key on a real desk, I’d answer “${text.length > 80 ? `${text.slice(0, 80)}…` : text}” using only what’s on this desk.`;
}

/** Splits a reply into the pieces a stream would bring: a word or two at a time, spaces kept. */
export function chunks(text: string): string[] {
  const words = text.match(/\S+\s*/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const n = 1 + ((i * 7) % 3);
    out.push(words.slice(i, i + n).join(''));
    i += n;
  }
  return out;
}
