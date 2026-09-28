import { Box, CircleAlert, Move, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { validateArea } from '../../core/geo/area';
import { useMediaQuery } from '../lib/browser';
import { formatCount, formatElapsed, formatMm } from '../lib/format';
import { cancelGeneration, generateModel } from '../state/actions';
import { filamentCount, resultGroups, settingsProblem } from '../state/derived';
import { dismissGenerationError, dismissMapHint, useApp } from '../state/store';
import { DownloadButton } from './ExportPanel';

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="progress-time">{formatElapsed((now - since) / 1000)}</span>;
}

function Progress() {
  const progress = useApp((state) => state.generation.progress);
  const startedAt = useApp((state) => state.generation.startedAt);
  const cancelling = useApp((state) => state.generation.cancelling);
  const fraction = Math.min(1, Math.max(0, progress?.fraction ?? 0));
  const percent = Math.round(fraction * 100);
  return (
    <div className="progress" aria-live="polite">
      <div className="progress-top">
        <span className="spinner" aria-hidden="true" />
        <span className="progress-label">{cancelling ? 'Cancelling' : (progress?.label ?? 'Starting')}</span>
        <span className="progress-percent">{percent}%</span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Generation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={progress?.label}
      >
        <div className="progress-fill" style={{ transform: `scaleX(${fraction})` }} />
      </div>
      <div className="progress-bottom">
        <span className="progress-detail">{progress?.detail ?? ''}</span>
        <Elapsed since={startedAt} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={cancelGeneration} disabled={cancelling}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ActionBar() {
  const status = useApp((state) => state.generation.status);
  const error = useApp((state) => state.generation.error);
  const result = useApp((state) => state.generation.result);
  const stale = useApp((state) => state.generation.stale);
  const palette = useApp((state) => state.palette);
  const area = useApp((state) => state.area);
  const settings = useApp((state) => state.settings);
  const problem = validateArea(area) ?? settingsProblem(settings);
  const running = status === 'running';
  const phone = useMediaQuery('(max-width: 900px)');
  const hintDismissed = useApp((state) => state.ui.mapHintDismissed);
  const view = useApp((state) => state.ui.view);
  const showHint = phone && !hintDismissed && view === 'map' && !result && !running;

  let summary = '';
  if (result) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = result.bounds;
    const colours = filamentCount(palette, resultGroups(result));
    summary = [
      `${formatMm(maxX - minX)} × ${formatMm(maxY - minY)} × ${formatMm(maxZ - minZ)} mm`,
      `${formatCount(result.triangles)} triangles`,
      `${colours} ${colours === 1 ? 'colour' : 'colours'}`,
    ].join(' · ');
  }

  return (
    <div className="action-bar">
      {showHint && (
        <div className="action-hint" role="note">
          <Move size={15} aria-hidden="true" />
          <span>Drag the box on the map to move it. Drag a corner to resize it, or the top handle to rotate it.</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss tip" onClick={dismissMapHint}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {status === 'error' && error && (
        <div className="alert" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <div className="alert-text">
            <strong>Could not generate the model</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={dismissGenerationError}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {running ? (
        <Progress />
      ) : (
        <>
          {result && (
            <div className="result-line">
              <span className="result-summary">{summary}</span>
              {stale && <span className="stale-note">Settings changed: regenerate</span>}
            </div>
          )}
          <div className="action-buttons">
            <button
              type="button"
              className={`btn btn-lg ${!result || stale ? 'btn-primary' : 'btn-secondary'} action-generate`}
              disabled={problem !== null}
              title={problem ?? undefined}
              onClick={() => void generateModel()}
            >
              {result ? <RefreshCw size={17} aria-hidden="true" /> : <Box size={17} aria-hidden="true" />}
              {!result ? 'Generate model' : stale ? 'Regenerate' : 'Generate again'}
            </button>
            {result && <DownloadButton compact primary={!stale} />}
          </div>
          {problem && status !== 'error' && <p className="action-problem">{problem}</p>}
        </>
      )}
    </div>
  );
}
