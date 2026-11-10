// What the Desk app imports to show the Agent app in its Agent window. The mock is a separate entry
// (`src/mock/mockAgentClient.ts`), so a production build that never imports it carries none of it.
import './ui/agent.css';

export { AgentApp, type AgentAppProps, type GuildMode } from './ui/AgentApp';
export { AgentError, newIdem, type AgentClient, type Mutation } from './client/agentClient';
export { RpcAgentClient, toAgentError, type DeskTransport } from './client/rpcAgentClient';
export { KeySecret } from './client/keySecret';
export type * from './client/types';
export * from './look';
