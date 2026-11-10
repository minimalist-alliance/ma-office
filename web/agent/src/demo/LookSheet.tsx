// The agent look on one page for review: every icon on every tone, in the theme chosen above, plus the pickers.
import { useState } from 'react';
import { AGENT_ICONS, AgentMark, DEFAULT_ICON, DEFAULT_TONE, FOREGROUND, IconPicker, TONES, ToneWheel, type LookTheme } from '../look';

export function LookSheet({ theme }: { theme: LookTheme }) {
  const [icon, setIcon] = useState(DEFAULT_ICON);
  const [tone, setTone] = useState(DEFAULT_TONE);
  return (
    <div className="look-sheet" data-testid="look-sheet">
      <section>
        <h2>Pick one</h2>
        <div className="look-pick">
          <AgentMark icon={icon} tone={tone} theme={theme} size={76} title="Preview" />
          <ToneWheel value={tone} theme={theme} onChange={setTone} />
          <div className="look-pick-icons">
            <IconPicker value={icon} onChange={setIcon} />
          </div>
        </div>
        <p>Foreground on every mark: {FOREGROUND}. Sizes: 20, 32, 48, 76.</p>
        <div className="look-row">
          {[20, 32, 48, 76].map((s) => (
            <AgentMark key={s} icon={icon} tone={tone} theme={theme} size={s} />
          ))}
        </div>
      </section>
      <section>
        <h2>Every icon on every tone ({theme})</h2>
        <div className="look-grid" style={{ gridTemplateColumns: `repeat(${AGENT_ICONS.length}, 40px)` }}>
          {TONES.flatMap((t) => AGENT_ICONS.map((i) => <AgentMark key={`${t.id}-${i.id}`} icon={i.id} tone={t.id} theme={theme} size={40} title={`${i.label}, ${t.label}`} />))}
        </div>
      </section>
    </div>
  );
}
