// Commons' room link on a Guild Desk (task 48): Commons' own `DataChannelLink` over the session's `commons` channel (channel 4),
// which a new session replaces. The room link waits through deskd's `{"t":"reset"}` and says hello again by itself; what the
// office adds is the hand-over from one session to the next, `attach()` with the new session's channel, as Commons' README
// ("Adopting it in the Desk app") has it. It reads nothing it carries.
import { DataChannelLink, type CommonsChannel } from '../../../apps/commons/web/src/net/channelLink.ts';
import type { CollabChannel, DeskLink } from '../desk/deskLink';

/** Our `CollabChannel` is the shape Commons takes, but for `Uint8Array`'s buffer type in `onMessage`. */
const asCommons = (ch: CollabChannel): CommonsChannel => ch as unknown as CommonsChannel;

export interface GuildRoomLink {
  readonly room: DataChannelLink;
  /** Stops following the desk's link and closes the room link. */
  stop(): void;
}

/** The room link for this Guild Desk's sessions, from the one open now, or null while no session has a `commons` channel. */
export function guildRoomLink(link: DeskLink): GuildRoomLink | null {
  const first = link.commons?.() ?? null;
  if (!first) return null;
  const room = new DataChannelLink(asCommons(first));
  let current: CollabChannel = first;
  const off = link.onStatus(() => {
    const next = link.commons?.() ?? null;
    if (!next || next === current) return;
    current = next;
    room.attach(asCommons(next));
  });
  return {
    room,
    stop: () => {
      off();
      room.close();
    },
  };
}
