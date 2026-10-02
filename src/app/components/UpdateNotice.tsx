import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { onAppOutdated } from '../state/engine';

// An installed app can stay open for days without a page load, which is when
// the browser normally checks for a new service worker.
const CHECK_EVERY = 60 * 60 * 1000;

// Set in the tab whose Reload started the update, the only one that reloads.
let updating = false;

async function applyUpdate(updateServiceWorker: () => Promise<void>) {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!registration?.waiting) {
    // Another tab already switched to the new version, or there's no service
    // worker (a private window) and a reload loads the new one.
    location.reload();
    return;
  }
  updating = true;
  // The plugin only reloads if this page was already controlled when it loaded,
  // so an update found during someone's first visit would otherwise do nothing.
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  await updateServiceWorker();
}

// A new version waits for Reload, so a deploy never reloads the page in the
// middle of generating a model. Reload in one tab activates the new version
// for every tab, but only that tab reloads: the plugin would reload them all,
// and with them any model someone chose Later to keep.
export function UpdateNotice() {
  // This tab still runs the old version under the new one. Its chunks and
  // workers are gone from the cache, so the first one it hasn't loaded yet
  // can fail until it reloads.
  const [outdated, setOutdated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      setInterval(() => {
        if (navigator.onLine && !registration.installing) registration.update().catch(() => {});
      }, CHECK_EVERY);
    },
    // Set only so the plugin doesn't reload this tab. The notice below comes
    // from the controller change itself: the plugin only calls this in tabs
    // that were controlled when they loaded.
    onNeedReload() {},
  });

  // A new version taking over this tab, or a chunk or LiDAR worker that won't
  // load after a deploy, is fixed by a reload, so ask for one. A tab's first
  // controller (a first visit) isn't an update.
  useEffect(() => {
    const failed = () => {
      setOutdated(true);
      setDismissed(false);
    };
    let controlled = Boolean(navigator.serviceWorker?.controller);
    const changed = () => {
      if (controlled && !updating) failed();
      controlled = true;
    };
    navigator.serviceWorker?.addEventListener('controllerchange', changed);
    window.addEventListener('vite:preloadError', failed);
    const stopListening = onAppOutdated(failed);
    return () => {
      navigator.serviceWorker?.removeEventListener('controllerchange', changed);
      window.removeEventListener('vite:preloadError', failed);
      stopListening();
    };
  }, []);

  if (outdated && !dismissed) {
    return (
      <div className="notice-toast floating" role="status">
        <span>Jarvizar City Model has been updated. Reload this tab to finish updating.</span>
        {/* A chunk can fail while the new version still waits, and a plain reload would keep the old one. */}
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void applyUpdate(updateServiceWorker)}>
          Reload
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setDismissed(true)}>
          Later
        </button>
      </div>
    );
  }
  if (!needRefresh || outdated) return null;
  return (
    <div className="notice-toast floating" role="status">
      <span>A new version of Jarvizar City Model is available.</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => void applyUpdate(updateServiceWorker)}>
        Reload
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
