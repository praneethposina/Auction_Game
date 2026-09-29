import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { Tier } from '../../../shared/data/companies.ts';
import { SECTORS, type SectorId } from '../../../shared/data/sectors.ts';
import { TIER_LABEL } from '../../../shared/economy.ts';
import { PERSONAS, type PlayerKind, type PublicAiSpec } from '../../../shared/types.ts';

export function SectorChip({ sector, short = false }: { sector: SectorId; short?: boolean }) {
  const s = SECTORS[sector];
  return (
    <span className="chip sector" style={{ '--c': s.color } as CSSProperties} title={s.why}>
      {s.icon} {short ? s.short : s.name}
    </span>
  );
}

export function TierChip({ tier }: { tier: Tier }) {
  return <span className={`chip tier-${tier}`}>{TIER_LABEL[tier]}</span>;
}

export function Monogram({ name, sector, size }: { name: string; sector: SectorId; size?: 'sm' | 'lg' }) {
  const letters = name
    .replace(/\(.*?\)/g, '')
    .split(/[\s.&-]+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <div className={`monogram ${size ?? ''}`} style={{ '--c': SECTORS[sector].color } as CSSProperties} aria-hidden>
      {letters || name[0]}
    </div>
  );
}

/** Re-render on an interval; returns the current time adjusted to the server clock. */
export function useServerNow(offset: number, intervalMs = 100): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(id);
  }, [offset, intervalMs]);
  return now;
}

export function Countdown({ endsAt, now, total }: { endsAt: number | null; now: number; total?: number }) {
  if (endsAt === null) return null;
  const left = Math.max(0, endsAt - now);
  const secs = Math.ceil(left / 1000);
  const urgent = left <= 3000;
  const label = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className={`countdown ${urgent ? 'urgent' : ''}`}>{label}</div>
      {total ? (
        <div className={`timer ${urgent ? 'urgent' : ''}`}>
          <div style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <span className="stack" style={{ gap: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="knob" />
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PlayerTag({ kind, model }: { kind: 'human' | 'bot' | 'llm'; model?: string }) {
  if (kind === 'human') return null;
  return <span className="chip ai">{kind === 'llm' ? `🤖 ${model ?? 'LLM'}` : '⚙️ Bot'}</span>;
}

/** An AI player's personality (strategy) under its name. Hidden when the host turned it off. */
export function PersonaLine({ kind, ai, blurb = true }: { kind: PlayerKind; ai?: PublicAiSpec; blurb?: boolean }) {
  if (kind === 'human' || !ai) return null;
  if (!ai.persona) return <div className="persona-line faint">🎭 Strategy hidden by the host</div>;
  const p = PERSONAS[ai.persona];
  return (
    <div className="persona-line" title={p.blurb}>
      🎭 <strong>{p.label}</strong>
      {blurb && <span className="muted"> · {p.blurb}</span>}
    </div>
  );
}

export function personaLabel(ai?: PublicAiSpec): string | null {
  return ai?.persona ? PERSONAS[ai.persona].label : null;
}
