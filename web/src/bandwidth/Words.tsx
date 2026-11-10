// The meter's words on screen, with a number kept on one line with its unit ("24 GB") and a time with its AM or PM
// ("12:00 AM"), so a narrow notice never breaks one across lines. The text itself is unchanged.
import './bandwidth.css';

const KEEP = /(\d[\d.,:]*\s(?:GB|MB|AM|PM)\b)/;

export function Words({ text }: { text: string }) {
  const parts = text.split(KEEP);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <span key={i} className="bw-nb">{p}</span> : p))}</>;
}
