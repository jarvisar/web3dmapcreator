import { useRegisterSW } from 'virtual:pwa-register/react';

// An installed app can stay open for days without a page load, which is when
// the browser normally checks for a new service worker.
const CHECK_EVERY = 60 * 60 * 1000;

async function applyUpdate(updateServiceWorker: () => Promise<void>) {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.waiting) {
    // Another tab already switched to the new version.
    location.reload();
    return;
  }
  // The plugin only reloads if this page was already controlled when it loaded,
  // so an update found during someone's first visit would otherwise do nothing.
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  await updateServiceWorker();
}

// A new version waits for Reload, so a deploy never reloads the page in the
// middle of generating a model.
export function UpdateNotice() {
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
  });

  if (!needRefresh) return null;
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
