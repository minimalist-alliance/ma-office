// The agent look's drawing (task 49), its own chunk: the 24 icons, the tones and the mark, which only an office with an agent
// tile needs. `roster.ts` loads it the first time one shows, and the tiles draw once it's here, a frame or two later.
export { drawAgentMark, RADIUS_SHARE } from '../../agent/src/look/draw';
export { AgentMark } from '../../agent/src/look/AgentMark';
