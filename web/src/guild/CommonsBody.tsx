// The lazy chunk behind `CommonsWindow`: Commons (`apps/commons/web/src`, imported as source, as the Notebook is) on this Guild
// Desk's `commons` channel through Commons' own `DataChannelLink` (`commonsLink.ts`). One room client per link, for the window's
// life: a new session hands its channel over, and the room client says hello again. Who the member is comes from deskd, never
// from here. A member's voice keeps its own connection to the Guild Desk, signaled over the same channel, through 443 where a
// network blocks the rest; nothing of it passes through Platform.
import { useEffect, useState } from 'react';
import { Commons, RoomClient } from '../../../apps/commons/web/src/index.ts';
import '../../../apps/commons/web/src/ui/commons.css';
import 'virtual:ma-commons-themes.css';
import type { DeskLink } from '../desk/deskLink';
import { guildRoomLink, type GuildRoomLink } from './commonsLink';

export interface CommonsBodyProps {
  link: DeskLink;
  /** The guild's name, as the room's title. */
  title: string;
  parked: boolean;
}

export default function CommonsBody({ link, title }: CommonsBodyProps) {
  const [room, setRoom] = useState<{ handle: GuildRoomLink; client: RoomClient } | null>(null);

  // The room link starts from a session's channel. The window mounts this only once the Guild Desk can answer, so there's one
  // at once; if not, the next session's brings it.
  useEffect(() => {
    let made: { handle: GuildRoomLink; client: RoomClient } | null = null;
    const tryMake = (): void => {
      if (made) return;
      const handle = guildRoomLink(link);
      if (!handle) return;
      made = { handle, client: new RoomClient(handle.room, {}) };
      setRoom(made);
    };
    tryMake();
    const off = link.onStatus(tryMake);
    return () => {
      off();
      made?.client.close();
      made?.handle.stop();
    };
  }, [link]);

  return (
    <div className="cmw-body" data-testid="commons-app">
      {room ? <Commons client={room.client} title={title} /> : null}
    </div>
  );
}
