// The bandwidth circle's panel (`BandwidthCircle.tsx` is the ring, its button and the heads-up): the week's and the month's
// numbers, when each resets, the state's line, Maia's line and the move up. It shows only on hover, a press or Enter, so it's
// in the top bar's popovers chunk (`chrome/popoversChunk.ts`), fetched once the page is idle.
import { DataGuardNotice } from '../chrome/DeskClosed';
import { currentBand } from '../platform/age';
import { loadedConfig } from '../platform/clientConfig';
import { formatBytes, formatGb, formatReset, shareOf, stateLine, type BandwidthMeter, type MeterWindow } from './meter';
import { maiaLine } from './maiaLine';
import type { useMaiaState } from './maiaState';
import { officerOffer } from './upgrade';
import { Words } from './Words';

function WindowRow({ label, w, resetText, warnAtPct }: { label: string; w: MeterWindow; resetText: string; warnAtPct: number }) {
  const share = Math.min(1, Math.max(0, Number.isFinite(shareOf(w)) ? shareOf(w) : 1));
  const used = formatBytes(w.usedBytes);
  const limit = formatGb(w.limitGb);
  return (
    <div className="bw-row">
      <div className="bw-head">
        <span>{label}</span>
        <b>{used} of {limit}</b>
      </div>
      <div
        className={`bw-bar${share * 100 >= warnAtPct ? ' warn' : ''}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(w.limitGb * 1000) / 1000}
        aria-valuenow={Math.min(w.usedGb, w.limitGb)}
        aria-valuetext={`${used} of ${limit}`}
      >
        <span style={{ width: `${share * 100}%` }} />
      </div>
      <p className="bw-reset">
        <Words text={`Resets ${resetText}`} />
      </p>
    </div>
  );
}

/**
 * `useMaia` is `useMaiaState`, handed over by `BandwidthCircle`: it stays in the first load as it was, so this chunk shares no
 * file named for Maia with the free tier's (the Maia specs watch for any such request while she's off).
 */
export function BandwidthPanel({ id, meter, now, useMaia }: { id: string; meter: BandwidthMeter; now: number; useMaia: typeof useMaiaState }) {
  const c = { now };
  const line = stateLine(meter, c);
  const maia = maiaLine(useMaia(), c);
  const offer = officerOffer(meter, currentBand(), loadedConfig());
  return (
    <div className="bw-panel" id={id} data-testid="bandwidth-panel">
      <p className="bw-title">Bandwidth</p>
      {meter.dataGuard && (
        <div className="bw-guard" data-testid="data-guard-panel">
          <DataGuardNotice message={meter.dataGuard.message} resumesAt={meter.dataGuard.resumesAt} guild={false} />
        </div>
      )}
      <WindowRow label="This week" w={meter.week} resetText={formatReset(meter.week.resetsAt, c)} warnAtPct={meter.warnAtPct} />
      <WindowRow label="This month" w={meter.month} resetText={formatReset(meter.month.resetsAt, c)} warnAtPct={meter.warnAtPct} />
      {line && (
        <p className={`bw-line ${meter.state}`} data-testid="bandwidth-line">
          <Words text={line} />
        </p>
      )}
      <p className="bw-note">What your desks send to you. Guild apps don't count.</p>
      {maia && (
        <p className="bw-note bw-maia" data-testid="bandwidth-maia">
          {maia}
        </p>
      )}
      {offer && (
        <p className="bw-note bw-offer" data-testid="bandwidth-offer">
          <Words text={offer.sentence} />
          {offer.href && (
            <>
              {' '}
              <a href={offer.href} target="_blank" rel="noopener" aria-description="Opens in a new tab">
                See membership
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
