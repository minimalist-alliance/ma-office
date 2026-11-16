// Words handed to Maia's room from elsewhere in the office (Documents' "Ask Maia" and "Ask Maia about this"): they wait in her
// composer for the member to finish and send, never sent by themselves. Tiny and outside the room's chunk, so whoever hands
// them over needn't load the room to do it; the room's chat takes them once (`Chat.tsx`).
import { create } from 'zustand';
import { enterMaiaMode, useMaiaMode } from './door';

export const useMaiaDraft = create<{ text: string | null; seq: number }>(() => ({ text: null, seq: 0 }));

/** Puts `text` in her composer, entering the room first if the member isn't in it. */
export function askMaia(text: string): void {
  useMaiaDraft.setState((s) => ({ text: text.slice(0, 500), seq: s.seq + 1 }));
  if (!useMaiaMode.getState().room) enterMaiaMode();
}

/** The chat took it. */
export function takeMaiaDraft(seq: number): void {
  if (useMaiaDraft.getState().seq === seq) useMaiaDraft.setState({ text: null });
}
