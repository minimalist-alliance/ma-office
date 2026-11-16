// The agent look (task 49; the hat and colours, Nov 15): icons, colours, tones, the one foreground color, and the components that show them.
import './look.css';

export { AGENT_ICONS, DEFAULT_ICON, RETIRED_ICONS, currentIcon, iconById, type AgentIcon } from './icons';
export { TONES, DEFAULT_TONE, RETIRED_TONES, currentTone, toneColor, type Tone, type LookTheme } from './tones';
export { FOREGROUND } from './foreground';
export { AgentMark, type AgentMarkProps } from './AgentMark';
export { ColorPicker, IconPicker, ToneWheel } from './Pickers';
export { AGENT_COLOR_LIST, LEAD_COLOR, agentColorHex, agentTileTint, isAgentColor, nextAgentColor, type AgentColor } from './colors';
export { HAT_ICON, wearsHat } from './icons';
export { HatMark } from './AgentMark';
export { colorFor, drawHat, hatTokens } from './hat';
export { drawAgentMark, PNG_ICON, type DrawMarkOptions } from './draw';
