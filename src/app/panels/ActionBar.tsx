import { CloudDownload, Download, Eye, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { LidarOffer } from '../../core/engine/protocol';
import { LIDAR_CACHE_LIMIT } from '../../core/data/cache';
import { editCount, unusedLayers } from '../../core/edit/types';
import { TaskProgress } from '../components/TaskProgress';
import { areaHint } from '../lib/area';
import { PHONE_QUERY, useMediaQuery } from '../lib/browser';
import { formatBytes, formatCount, formatInteger, formatMm, formatNumber } from '../lib/format';
import { useState } from 'react';
import { cancelExport, cancelGeneration, exportModel, generateModel } from '../state/actions';
import { FORMAT_EXTENSIONS, filamentCount, generationProblem, hiddenDownloadParts, modelSize, resultGroups } from '../state/derived';
import { getEditData } from '../state/model';
import { areaResizable, dismissExportError, dismissGenerationError, dismissMapHint, dismissOffers, setView, snapshotKey, useApp } from '../state/store';
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
      remaining={progress?.remaining}
      onCancel={cancelGeneration}
      cancelling={cancelling}
    />
  );
}

// In place of Generate again while a download is made, which can't be both.
function CancelExportButton() {
  const [asked, setAsked] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-lg"
      disabled={asked}
      onClick={() => {
        setAsked(true);
        cancelExport();
      }}
    >
      {asked ? 'Cancelling' : 'Cancel'}
    </button>
  );
}

function DownloadButton({ primary }: { primary: boolean }) {
  const result = useApp((state) => state.generation.result);
  const exporting = useApp((state) => state.exporting);
  const format = useApp((state) => state.exportSettings.format);
  const hidden = useApp((state) => state.ui.hiddenParts);
  const edits = useApp((state) => state.edits);
  const allHidden = result ? hiddenDownloadParts(result, edits, getEditData(), hidden).all : false;
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

function offerLine(offer: LidarOffer, failed: boolean): string {
  const name = `${offer.name}${offer.year ? ` (${offer.year})` : ''}`;
  const count = (n: number) => `${formatCount(n)} ${n === 1 ? 'building' : 'buildings'}`;
  const buildings = offer.buildings === undefined ? null : count(offer.buildings);
  if (offer.reason === 'chosen') return buildings ? `${name}, the survey picked under Layers, would measure ${buildings}.` : `${name} is the survey picked under Layers.`;
  // A LiDAR only model that couldn't be built had nothing else to read,
  // unless something it could read failed, which the error says.
  if (failed && !offer.failure) return `${name} has the only LiDAR for this area.`;
  if (offer.buildings !== undefined) {
    // One offer can cover gaps for some buildings and be newer than what others were measured from.
    const counts = offer.counts ?? { [offer.reason]: offer.buildings };
    const parts = [
      counts.gap ? `has LiDAR for ${count(counts.gap)} nothing else measured` : '',
      counts.newer ? `is much newer than what ${count(counts.newer)} were measured from` : '',
      counts.denser ? `is much denser than what ${count(counts.denser)} were measured from` : '',
    ].filter(Boolean);
    if (parts.length) return `${name} ${parts.join(', and ')}.`;
  }
  if (offer.reason === 'gap') return `${name} covers parts of the area nothing else does.`;
  return `${name} is ${offer.reason === 'newer' ? 'much newer' : 'much denser'} than the survey read here.`;
}

/**
 * Surveys that only come as whole files, offered rather than downloaded, as
 * the add-on did. Approving them regenerates with their tiles.
 */
/** The last generation's offers, while the area and settings are still the ones they were made for. */
function useOffers() {
  const offers = useApp((state) => state.generation.offers);
  const current = useApp((state) => (state.generation.offers ? snapshotKey(state.area, state.settings) : ''));
  return offers && offers.key === current ? offers : null;
}

function LidarOffers({ failed }: { failed: boolean }) {
  const offers = useOffers();
  if (!offers) return null;
  const tiles = [...new Set(offers.list.flatMap((o) => o.tiles))];
  const bytes = offers.list.reduce((sum, o) => sum + o.bytes, 0);
  const unsized = offers.list.reduce((sum, o) => sum + o.unsized, 0);
  const count = `${formatCount(tiles.length)} ${tiles.length === 1 ? 'tile' : 'tiles'}`;
  const size = bytes ? `, about ${bytes >= 1e9 ? `${formatNumber(bytes / 1e9, 1)} GB` : formatBytes(bytes)}${unsized ? ` plus ${unsized} of unknown size` : ''}` : ' of unknown size';
  const gb = (value: number) => `${formatNumber(value / 1e9, value % 1e9 ? 1 : 0)} GB`;
  // Past what the cache keeps, reading them again (another setting, a moved area) downloads them again.
  const kept =
    bytes <= LIDAR_CACHE_LIMIT && !offers.list.some((o) => o.uncached)
      ? `, and the LiDAR cache keeps up to ${gb(LIDAR_CACHE_LIMIT)} of them for next time.`
      : `. That's more than the LiDAR cache keeps (${gb(LIDAR_CACHE_LIMIT)}), so changing a LiDAR setting or the area later can download them again.`;
  return (
    <div className="notice offer-notice" role="status">
      <CloudDownload size={14} aria-hidden="true" />
      <div className="alert-text">
        <strong>LiDAR to download</strong>
        {offers.list.map((offer) => (
          <span key={offer.url}>{offerLine(offer, failed)}</span>
        ))}
        <span>
          {count}
          {size}. They come as whole files, so this can take a while{kept}
        </span>
        <div className="offer-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void generateModel({ approveTiles: tiles })}>
            Download and regenerate
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={dismissOffers}>
            Not now
          </button>
        </div>
      </div>
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
  const shownBounds = useApp((state) => state.ui.shownBounds);
  const largeGrids = useApp((state) => state.ui.largeGrids);
  const problem = generationProblem(area, settings, largeGrids);
  const running = status === 'running';
  // An offer says what the error would, with a way forward, unless a read failed as well.
  const offers = useOffers();

  let summary = '';
  let note = '';
  if (result) {
    // As shown, so a building made taller or a shape counts.
    const { w, d, h } = modelSize(result, shownBounds);
    const unused = new Set(unusedLayers(edits));
    const colours = filamentCount(palette, resultGroups(result), edits.layers.filter((layer) => !unused.has(layer.id)));
    const changes = editCount(edits);
    summary = [
      `${formatMm(w)} × ${formatMm(d)} × ${formatMm(h)} mm`,
      `${formatCount(result.triangles)} triangles`,
      `${colours} ${colours === 1 ? 'colour' : 'colours'}`,
      ...(changes ? [`${changes} ${changes === 1 ? 'edit' : 'edits'}`] : []),
    ].join(' · ');
    const hiddenParts = hiddenDownloadParts(result, edits, getEditData(), hidden);
    const hiddenCount = hiddenParts.hidden;
    if (!result.exportable) note = 'The generator was restarted. Generate the model again before downloading.';
    else if (hiddenParts.all) note = 'Every part is hidden in the 3D view, so there is nothing to download.';
    else if (hiddenCount > 0) note = `${hiddenCount} hidden ${hiddenCount === 1 ? 'part is' : 'parts are'} left out of the download.`;
  }

  return (
    <>
      {status === 'error' && error && (!offers || offers.list.some((offer) => offer.failure)) && <Alert title="Could not generate the model" text={error} onDismiss={dismissGenerationError} />}
      {exportError && <Alert title="Could not export the model" text={exportError} onDismiss={dismissExportError} />}
      {!running && !exporting && <LidarOffers failed={status === 'error'} />}

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
            {exporting ? (
              <CancelExportButton />
            ) : (
              <button
                type="button"
                className={`btn btn-lg${!result || stale ? ' btn-primary' : ''}`}
                disabled={problem !== null}
                title={problem ?? undefined}
                onClick={() => void generateModel()}
              >
                {result && <RefreshCw size={15} aria-hidden="true" />}
                {!result ? 'Generate model' : stale ? 'Regenerate' : 'Generate again'}
              </button>
            )}
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
  const resizable = useApp((state) => areaResizable(state));
  const idle = useApp((state) => state.generation.result === null && state.generation.status !== 'running');
  const svgIdle = useSvgRender((state) => state.result === null && state.status !== 'working');
  const phone = useMediaQuery(PHONE_QUERY);
  const showHint = phone && !hintDismissed && !drawerOpen && view === 'map' && (output === 'model' ? idle : svgIdle);
  return (
    <div className="action-bar">
      {showHint && (
        <div className="action-hint" role="note">
          <span>{areaHint(resizable)}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss tip" onClick={dismissMapHint}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {output === 'model' ? <ModelActions /> : <SvgActions />}
    </div>
  );
}
