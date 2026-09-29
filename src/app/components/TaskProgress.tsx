import { useEffect, useState } from 'react';
import { formatElapsed } from '../lib/format';

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="progress-time">{formatElapsed((now - since) / 1000)}</span>;
}

interface TaskProgressProps {
  label: string;
  ariaLabel: string;
  valueText?: string;
  percent: number;
  detail: string;
  startedAt: number;
  onCancel: () => void;
  cancelling?: boolean;
}

export function TaskProgress({ label, ariaLabel, valueText, percent, detail, startedAt, onCancel, cancelling }: TaskProgressProps) {
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
        <Elapsed since={startedAt} />
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={cancelling}>
          Cancel
        </button>
      </div>
    </div>
  );
}
