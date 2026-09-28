import { LucideProvider } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { Toasts } from './components/Toasts';
import { HelpDialog } from './layout/HelpDialog';
import { TopBar } from './layout/TopBar';
import { NARROW_QUERY, useMediaQuery } from './lib/browser';
import { MapView } from './map/MapView';
import { ActionBar } from './panels/ActionBar';
import { Sidebar } from './panels/Sidebar';
import { setDrawerOpen, useApp } from './state/store';

// three.js is only needed once there is a model, so it loads on demand.
const ModelView = lazy(() => import('./viewer/ModelView'));

export function App() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const drawerOpen = useApp((state) => state.ui.drawerOpen);
  const view = useApp((state) => state.ui.view);
  const needsViewer = useApp((state) => state.generation.result !== null || state.generation.status === 'running');
  const drawer = narrow && drawerOpen;

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
    <LucideProvider size={16} strokeWidth={1.75}>
      <div className={`app${narrow ? ' is-narrow' : ''}${drawer ? ' drawer-open' : ''}`}>
        <TopBar narrow={narrow} />
        <aside id="sidebar" className="sidebar" aria-label="Model settings" inert={narrow && !drawerOpen}>
          <Sidebar />
        </aside>
        {narrow && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
        <main className="main" aria-label={view === 'map' ? 'Map' : '3D model'}>
          <MapView active={view === 'map'} />
          {needsViewer && (
            <Suspense fallback={<div className="viewer viewer-loading" />}>
              <ModelView active={view === 'model'} />
            </Suspense>
          )}
          <Toasts />
        </main>
        <ActionBar />
        <HelpDialog />
      </div>
    </LucideProvider>
  );
}
