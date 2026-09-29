import { LucideProvider } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { Toasts } from './components/Toasts';
import { HelpDialog } from './layout/HelpDialog';
import { TopBar } from './layout/TopBar';
import { NARROW_QUERY, useMediaQuery } from './lib/browser';
import { MapView } from './map/MapView';
import { ActionBar } from './panels/ActionBar';
import { Sidebar } from './panels/Sidebar';
import { setDrawerOpen, useApp } from './state/store';
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

  // The drawer closes itself after a search or preset. Focus was inside it,
  // and it is inert now, so hand focus to the button that opens it.
  const wasOpen = useRef(drawer);
  useEffect(() => {
    const closed = wasOpen.current && !drawer;
    wasOpen.current = drawer;
    const active = document.activeElement;
    if (closed && (active === document.body || document.getElementById('sidebar')?.contains(active))) {
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

  return (
    <LucideProvider size={14} strokeWidth={2}>
      <div className={`app${narrow ? ' is-narrow' : ''}${drawer ? ' drawer-open' : ''}`}>
        <TopBar narrow={narrow} />
        <aside id="sidebar" className="sidebar" aria-label="Settings" inert={narrow && !drawerOpen}>
          <Sidebar />
        </aside>
        {narrow && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
        <main className="main" aria-label={view === 'map' ? 'Map' : output === 'model' ? '3D model' : 'SVG preview'}>
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
      </div>
    </LucideProvider>
  );
}
