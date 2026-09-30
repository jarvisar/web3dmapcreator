import { Download, Eye, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { editCount, unusedLayers } from '../../core/edit/types';
import { TaskProgress } from '../components/TaskProgress';
import { areaHint } from '../lib/area';
import { PHONE_QUERY, useMediaQuery } from '../lib/browser';
import { formatCount, formatInteger, formatMm, formatNumber } from '../lib/format';
import { cancelGeneration, exportModel, generateModel } from '../state/actions';
import { FORMAT_EXTENSIONS, filamentCount, generationProblem, resultGroups } from '../state/derived';
import { dismissExportError, dismissGenerationError, dismissMapHint, setView, useApp } from '../state/store';
import { downloadSvg, generateSvg, svgProblem, useSvgKey } from '../svgmap/actions';
import { cancelRender, renderFraction, useSvgRender } from '../svgmap/render';

function Progress() {
  const progress = useApp((state) => state.generation.progress);
  const startedAt = useApp((state) => state.generation.startedAt);
  const cancelling = useApp((state) => state.generation.cancelling);
  const fraction = Math.min(1, Math.max(0, progress?.fraction ?? 0));
  const percent = Math.round(fraction * 100);
  return (
    <TaskProgress
      label={cancelling ? 'Cancelling' : (progress?.label ?? 'Starting')}
      ariaLabel="Generation progress"
      valueText={progress?.label}
      percent={percent}
      detail={progress?.detail ?? ''}
      startedAt={startedAt}
      onCancel={cancelGeneration}
      cancelling={cancelling}
    />
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

function ModelActions() {
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
  const edits = useApp((state) => state.edits);
  const problem = generationProblem(area, settings);
  const running = status === 'running';

  let summary = '';
  let note = '';
  if (result) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = result.bounds;
    const unused = new Set(unusedLayers(edits));
    const colours = filamentCount(palette, resultGroups(result), edits.layers.filter((layer) => !unused.has(layer.id)));
    const changes = editCount(edits);
    summary = [
      `${formatMm(maxX - minX)} × ${formatMm(maxY - minY)} × ${formatMm(maxZ - minZ)} mm`,
      `${formatCount(result.triangles)} triangles`,
      `${colours} ${colours === 1 ? 'colour' : 'colours'}`,
      ...(changes ? [`${changes} ${changes === 1 ? 'edit' : 'edits'}`] : []),
    ].join(' · ');
    const hiddenCount = result.parts.filter((part) => hidden.includes(part.id)).length;
    if (!result.exportable) note = 'The generator was restarted. Generate the model again before downloading.';
    else if (hiddenCount === result.parts.length) note = 'Every part is hidden in the 3D view, so there is nothing to download.';
    else if (hiddenCount > 0) note = `${hiddenCount} hidden ${hiddenCount === 1 ? 'part is' : 'parts are'} left out of the download.`;
  }

  return (
    <>
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
    </>
  );
}

function SvgProgress() {
  const progress = useSvgRender((state) => state.progress);
  const startedAt = useSvgRender((state) => state.startedAt);
  const percent = Math.round(renderFraction(progress) * 100);
  const counted = progress?.total ? `${formatInteger(progress.done ?? 0)} of ${formatInteger(progress.total)} tiles` : '';
  return (
    <TaskProgress
      label={progress?.message ?? 'Starting'}
      ariaLabel="SVG progress"
      valueText={progress?.message}
      percent={percent}
      detail={counted}
      startedAt={startedAt}
      onCancel={cancelRender}
    />
  );
}

// An SVG draws in seconds and the preview follows the settings, so there's
// no Regenerate: from the map, the first button renders or opens the preview.
function SvgActions() {
  const status = useSvgRender((state) => state.status);
  const result = useSvgRender((state) => state.result);
  const resultKey = useSvgRender((state) => state.resultKey);
  const triedKey = useSvgRender((state) => state.triedKey);
  const error = useSvgRender((state) => state.error);
  const key = useSvgKey();
  const view = useApp((state) => state.ui.view);
  const problem = useApp((state) => svgProblem(state.area, state.svg));
  const working = status === 'working';
  const stale = result !== null && key !== resultKey;
  // Missing tiles are only tried again on a render, and the settings haven't changed to start one.
  const incomplete = result !== null && !stale && result.stats.missingTiles > 0;
  // The open preview doesn't try the same settings twice on its own, so after
  // a failed or cancelled update it needs a button.
  const gaveUp = stale && !working && triedKey === key;

  // Renders started from the map show their progress. The open preview updates quietly.
  if (working && (!result || view === 'map')) return <SvgProgress />;

  let summary = '';
  if (result) {
    const paths = result.groups.reduce((n, group) => n + group.subpaths, 0);
    summary = [
      `${formatNumber(result.width, 1)} × ${formatNumber(result.height, 1)} mm`,
      `1:${formatInteger(result.meta.scale)}`,
      `${formatCount(paths)} paths`,
      ...(result.stats.coverage !== null ? [`${formatNumber(result.stats.coverage * 100, 1)}% of roads kept`] : []),
    ].join(' · ');
  }

  type First = { label: string; icon: 'eye' | 'refresh' | null; primary: boolean; onClick: () => void };
  let first: First | null = null;
  const update = (label: string): First => ({ label, icon: 'refresh', primary: true, onClick: generateSvg });
  if (!result) first = { ...update('Generate SVG'), icon: null };
  else if (working) first = { label: 'Cancel', icon: null, primary: false, onClick: cancelRender };
  else if (status === 'error' && stale) first = update('Try again');
  else if (incomplete) first = update('Retry map data');
  else if (view === 'map') first = stale ? update('Update SVG') : { label: 'Show preview', icon: 'eye', primary: false, onClick: () => setView('result') };
  else if (gaveUp) first = update('Update SVG');

  return (
    <>
      {status === 'error' && error && (
        <Alert
          title="Could not make the SVG"
          text={error}
          onDismiss={() => useSvgRender.setState((state) => ({ status: state.result ? 'done' : 'idle', error: null }))}
        />
      )}
      {result && (
        <div className="result-line">
          <span>{summary}</span>
          {working ? <span className="stale-note is-updating">Updating</span> : stale && <span className="stale-note">Settings changed</span>}
        </div>
      )}
      <div className="action-buttons">
        {first && (
          <button
            type="button"
            className={`btn btn-lg${first.primary ? ' btn-primary' : ''}`}
            disabled={problem !== null && !working}
            title={problem ?? undefined}
            onClick={first.onClick}
          >
            {first.icon === 'eye' && <Eye size={15} aria-hidden="true" />}
            {first.icon === 'refresh' && <RefreshCw size={15} aria-hidden="true" />}
            {first.label}
          </button>
        )}
        {result && (
          <button type="button" className={`btn btn-lg${first?.primary ? '' : ' btn-primary'}`} disabled={working} onClick={downloadSvg}>
            <Download size={16} aria-hidden="true" />
            Download .svg
          </button>
        )}
      </div>
      {problem && status !== 'error' && <p className="action-problem">{problem}</p>}
    </>
  );
}

export function ActionBar() {
  const output = useApp((state) => state.output);
  const hintDismissed = useApp((state) => state.ui.mapHintDismissed);
  const view = useApp((state) => state.ui.view);
  const drawerOpen = useApp((state) => state.ui.drawerOpen);
  const locked = useApp((state) => state.output === 'svg' && state.svg.scaleLocked);
  const idle = useApp((state) => state.generation.result === null && state.generation.status !== 'running');
  const svgIdle = useSvgRender((state) => state.result === null && state.status !== 'working');
  const phone = useMediaQuery(PHONE_QUERY);
  const showHint = phone && !hintDismissed && !drawerOpen && view === 'map' && (output === 'model' ? idle : svgIdle);
  return (
    <div className="action-bar">
      {showHint && (
        <div className="action-hint" role="note">
          <span>{areaHint(locked)}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss tip" onClick={dismissMapHint}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {output === 'model' ? <ModelActions /> : <SvgActions />}
    </div>
  );
}
