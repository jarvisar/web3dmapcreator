import { LucideProvider } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type DragEvent } from 'react';
import { Toasts } from './components/Toasts';
import { HelpDialog } from './layout/HelpDialog';
import { TopBar } from './layout/TopBar';
import { NARROW_QUERY, useMediaQuery } from './lib/browser';
import { MapView } from './map/MapView';
import { ActionBar } from './panels/ActionBar';
import { Sidebar } from './panels/Sidebar';
import { setDrawerOpen, toast, useApp } from './state/store';
import { importTrackFiles } from './state/tracks';
import { SvgPreview } from './svgmap/Preview';

// three.js is only needed once there is a model, so it loads on demand.
const ModelView = lazy(() => import('./viewer/ModelView'));

export function App() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const drawerOpen = useApp((state) => state.ui.drawerOpen);
  const view = useApp((state) => state.ui.view);
  const output = useApp((state) => state.output);
  const needsViewer = useApp((state) => state.generation.result !== null || state.generation.status === 'running');
  const drawer = narrow && drawerOpen;
  const [dropping, setDropping] = useState(false);
  const dropTimer = useRef(0);

  // The open drawer covers the map, which goes inert under it, so focus
  // moves into the drawer. The drawer closes itself after a search or
  // preset. Focus was inside it, and it is inert now, so hand focus to the
  // button that opens it.
  const wasOpen = useRef(drawer);
  useEffect(() => {
    const opened = !wasOpen.current && drawer;
    const closed = wasOpen.current && !drawer;
    wasOpen.current = drawer;
    const sidebar = document.getElementById('sidebar');
    const active = document.activeElement;
    if (opened && !sidebar?.contains(active)) sidebar?.focus();
    if (closed && (active === document.body || sidebar?.contains(active))) {
      document.querySelector<HTMLElement>('.drawer-toggle')?.focus();
    }
  }, [drawer]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
        setDrawerOpen(false);
        document.querySelector<HTMLElement>('.drawer-toggle')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  // A route file dropped anywhere on the page, while making a model.
  // dragleave fires for every child the pointer crosses, so the overlay
  // goes when dragover stops coming instead.
  const isFileDrag = (event: DragEvent) => output === 'model' && Array.from(event.dataTransfer.types).includes('Files');
  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropping(true);
    clearTimeout(dropTimer.current);
    dropTimer.current = window.setTimeout(() => setDropping(false), 200);
  };
  const onDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    clearTimeout(dropTimer.current);
    setDropping(false);
    // The browser empties the list once the event is over.
    const files = Array.from(event.dataTransfer.files);
    void importTrackFiles(files).then(({ errors }) => {
      if (errors.length) toast(errors.join(' '), 'error');
    });
  };

  return (
    <LucideProvider size={14} strokeWidth={2}>
      <div className={`app${narrow ? ' is-narrow' : ''}${drawer ? ' drawer-open' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
        <TopBar narrow={narrow} />
        <aside id="sidebar" className="sidebar" aria-label="Settings" tabIndex={-1} inert={narrow && !drawerOpen}>
          <Sidebar />
        </aside>
        {narrow && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
        <main className="main" aria-label={view === 'map' ? 'Map' : output === 'model' ? '3D model' : 'SVG preview'} inert={drawer}>
          <MapView active={view === 'map'} />
          {needsViewer && (
            <Suspense fallback={null}>
              <ModelView active={view === 'result' && output === 'model'} />
            </Suspense>
          )}
          {view === 'result' && output === 'svg' && <SvgPreview />}
          <Toasts />
        </main>
        <ActionBar />
        <HelpDialog />
        {dropping && (
          <div className="drop-overlay" aria-hidden="true">
            <div className="drop-message">Drop GPX, KML, KMZ, TCX, FIT or GeoJSON files to add them as routes</div>
          </div>
        )}
      </div>
    </LucideProvider>
  );
}
