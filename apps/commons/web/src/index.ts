// Commons as a module: the Desk app imports src/ as source, as it does the Notebook. On a guild desk it hands Commons
// its `commons` data channel (channel 4) through DataChannelLink; the WebSocket links are for -dev.
export { Commons, type CommonsProps } from './ui/Commons.tsx';
export {
  RoomClient,
  MAX_CHAT,
  type RoomClientOptions,
  type RoomState,
  type Member,
  type BoardMeta,
  type Channel,
  type ChatMsg,
  type Thread,
  type Settings,
} from './room/client.ts';
export { WebSocketLink, type CommonsLink, type LinkState } from './net/link.ts';
export { DataChannelLink, WebSocketChannel, fromDataChannel, type CommonsChannel, type ChannelEnd, type DataChannelLike } from './net/channelLink.ts';
export { PROTOCOL_VERSION, MAX_MESSAGE } from './net/protocol.ts';
export { BoardEngine, type Tool } from './board/engine.ts';
export { commonsThemeCss, COMMONS_THEMES } from './theme/tokens.ts';
