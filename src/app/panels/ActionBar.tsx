import { Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AREA_HINT } from '../lib/area';
import { PHONE_QUERY, useMediaQuery } from '../lib/browser';
import { formatCount, formatElapsed, formatMm } from '../lib/format';
import { cancelGeneration, exportModel, generateModel } from '../state/actions';
import { FORMAT_EXTENSIONS, filamentCount, generationProblem, resultGroups } from '../state/derived';
import { dismissExportError, dismissGenerationError, dismissMapHint, useApp } from '../state/store';

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
    <div className="progress">
      <div className="progress-top">
        <span className="progress-label" aria-live="polite">{cancelling ? 'Cancelling' : (progress?.label ?? 'Starting')}</span>
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
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-bottom">
        <span className="progress-detail">{progress?.detail ?? ''}</span>
        <Elapsed since={startedAt} />
        <button type="button" className="btn btn-sm" onClick={cancelGeneration} disabled={cancelling}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function DownloadButton({ primary }: { primary: boolean }) {
  const result = useApp((state) => state.generation.result);
  const exporting = useApp((state) => state.exporting);
  const format = useApp((state) => state.exportSettings.format);
  const hidden = useApp((state) => state.ui.hiddenParts);
  const allHidden = result ? result.parts.every((part) => hidden.includes(part.id)) : false;
  const running = exporting.status === 'running';
  const disabled = !result || running || allHidden || !result.exportable;
  return (
    <button
      type="button"
      className={`btn btn-lg${primary ? ' btn-primary' : ''}`}
      disabled={disabled}
      aria-busy={running}
      title={allHidden ? 'Every part is hidden in the 3D view' : undefined}
      onClick={() => void exportModel()}
    >
      {running ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
      {running
        ? `Preparing${exporting.progress ? ` ${Math.round(exporting.progress.fraction * 100)}%` : ''}`
        : `Download ${FORMAT_EXTENSIONS[format]}`}
    </button>
  );
}

function Alert({ title, text, onDismiss }: { title: string; text: string; onDismiss: () => void }) {
  return (
    <div className="alert" role="alert">
      <div className="alert-text">
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
      <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={onDismiss}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ActionBar() {
  const status = useApp((state) => state.generation.status);
  const error = useApp((state) => state.generation.error);
  const result = useApp((state) => state.generation.result);
  const stale = useApp((state) => state.generation.stale);
  const exportError = useApp((state) => state.exporting.error);
  const exporting = useApp((state) => state.exporting.status === 'running');
  const palette = useApp((state) => state.palette);
  const area = useApp((state) => state.area);
  const settings = useApp((state) => state.settings);
  const hidden = useApp((state) => state.ui.hiddenParts);
  const hintDismissed = useApp((state) => state.ui.mapHintDismissed);
  const view = useApp((state) => state.ui.view);
  const drawerOpen = useApp((state) => state.ui.drawerOpen);
  const phone = useMediaQuery(PHONE_QUERY);
  const problem = generationProblem(area, settings);
  const running = status === 'running';
  const showHint = phone && !hintDismissed && !drawerOpen && view === 'map' && !result && !running;

  let summary = '';
  let note = '';
  if (result) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = result.bounds;
    const colours = filamentCount(palette, resultGroups(result));
    summary = [
      `${formatMm(maxX - minX)} × ${formatMm(maxY - minY)} × ${formatMm(maxZ - minZ)} mm`,
      `${formatCount(result.triangles)} triangles`,
      `${colours} ${colours === 1 ? 'colour' : 'colours'}`,
    ].join(' · ');
    const hiddenCount = result.parts.filter((part) => hidden.includes(part.id)).length;
    if (!result.exportable) note = 'The generator was restarted. Generate the model again before downloading.';
    else if (hiddenCount === result.parts.length) note = 'Every part is hidden in the 3D view, so there is nothing to download.';
    else if (hiddenCount > 0) note = `${hiddenCount} hidden ${hiddenCount === 1 ? 'part is' : 'parts are'} left out of the download.`;
  }

  return (
    <div className="action-bar">
      {showHint && (
        <div className="action-hint" role="note">
          <span>{AREA_HINT}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss tip" onClick={dismissMapHint}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {status === 'error' && error && <Alert title="Could not generate the model" text={error} onDismiss={dismissGenerationError} />}
      {exportError && <Alert title="Could not export the model" text={exportError} onDismiss={dismissExportError} />}

      {running ? (
        <Progress />
      ) : (
        <>
          {result && (
            <div className="result-line">
              <span>{summary}</span>
              {stale && <span className="stale-note">Settings changed</span>}
            </div>
          )}
          <div className="action-buttons">
            <button
              type="button"
              className={`btn btn-lg${!result || stale ? ' btn-primary' : ''}`}
              disabled={problem !== null || exporting}
              title={problem ?? (exporting ? 'Wait for the download to finish' : undefined)}
              onClick={() => void generateModel()}
            >
              {result && <RefreshCw size={15} aria-hidden="true" />}
              {!result ? 'Generate model' : stale ? 'Regenerate' : 'Generate again'}
            </button>
            {result && <DownloadButton primary={!stale} />}
          </div>
          {note && <p className="result-note">{note}</p>}
          {problem && status !== 'error' && <p className="action-problem">{problem}</p>}
        </>
      )}
    </div>
  );
}
