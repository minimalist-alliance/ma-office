// The polite live region (design 3.11). A store, so anything can announce without prop drilling.
import { create } from 'zustand';

export const useAnnouncer = create<{ text: string }>(() => ({ text: '' }));

export function announce(text: string): void {
  useAnnouncer.setState({ text });
}
