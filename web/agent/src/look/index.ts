// The agent look (task 49): icons, tones, the one foreground color, and the components that show them.
import './look.css';

export { AGENT_ICONS, DEFAULT_ICON, RETIRED_ICONS, currentIcon, iconById, type AgentIcon } from './icons';
export { TONES, DEFAULT_TONE, RETIRED_TONES, currentTone, toneColor, type Tone, type LookTheme } from './tones';
export { FOREGROUND } from './foreground';
export { AgentMark, type AgentMarkProps } from './AgentMark';
export { IconPicker, ToneWheel } from './Pickers';
export { drawAgentMark, PNG_ICON, type DrawMarkOptions } from './draw';
