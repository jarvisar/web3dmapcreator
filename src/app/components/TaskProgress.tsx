import { useEffect, useRef, useState } from 'react';
import { formatElapsed, formatTimeLeft } from '../lib/format';

// No time left in the first seconds, while the estimates settle.
const SETTLE_MS = 2000;

/**
 * Elapsed time, and the time left when the job gives one. The time left
 * counts down between updates and eases towards each new estimate, so it
 * doesn't jump about with every one: quickly when it falls, slowly when it
 * rises. LiDAR's estimates fell from 59 to 14 s in 7 s, and easing them
 * evenly still said a minute with 14 s to go.
 */
function Clock({ since, remaining }: { since: number; remaining?: number }) {
  const [now, setNow] = useState(() => Date.now());
  const [left, setLeft] = useState<number | null>(null);
  const latest = useRef<{ value: number; at: number } | null>(null);
  useEffect(() => {
    latest.current = remaining === undefined ? null : { value: remaining, at: Date.now() };
    if (remaining === undefined) setLeft(null);
  }, [remaining]);
  useEffect(() => {
    let shown: { value: number; at: number } | null = null;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      const estimate = latest.current;
      if (!estimate || time - since < SETTLE_MS) {
        shown = null;
        setLeft(null);
        return;
      }
      const target = estimate.value - (time - estimate.at) / 1000;
      const counted = shown ? shown.value - (time - shown.at) / 1000 : target;
      const ease = !shown ? 1 : target < counted ? 0.75 : 0.3;
      shown = { value: Math.max(1, counted + (target - counted) * ease), at: time };
      setLeft(shown.value);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [since]);

  return (
    <span className="progress-time">
      {formatElapsed((now - since) / 1000)}
      {left !== null && ` · ${formatTimeLeft(left)}`}
    </span>
  );
}

interface TaskProgressProps {
  label: string;
  ariaLabel: string;
  valueText?: string;
  percent: number;
  detail: string;
  startedAt: number;
  /** Seconds the job should still take, when it knows. */
  remaining?: number;
  onCancel: () => void;
  cancelling?: boolean;
}

export function TaskProgress({ label, ariaLabel, valueText, percent, detail, startedAt, remaining, onCancel, cancelling }: TaskProgressProps) {
  return (
    <div className="progress">
      <div className="progress-top">
        <span className="progress-label" aria-live="polite">{label}</span>
        <span className="progress-percent">{percent}%</span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-bottom">
        <span className="progress-detail">{detail}</span>
        <Clock since={startedAt} remaining={cancelling ? undefined : remaining} />
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={cancelling}>
          Cancel
        </button>
      </div>
    </div>
  );
}
