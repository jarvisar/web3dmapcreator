import { useEffect, useState } from 'react';

// Chromium only, and not in the DOM types.
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'jarvizar-city-model:install-dismissed';

function wasDismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return false;
  }
}

function rememberDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    // Private mode. It shows again next visit.
  }
}

const nav = navigator as Navigator & { standalone?: boolean };
const standalone = matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
// iOS has no install event, so explain the Share menu instead. navigator.standalone
// only exists on iOS and iPadOS.
const ios = 'standalone' in nav && !standalone;

// Listen from the start since Chrome can fire this before React mounts.
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

window.addEventListener('beforeinstallprompt', (event) => {
  // Once dismissed, leave the browser's own install UI alone.
  if (wasDismissed()) return;
  // Stops Chrome's mini-infobar on Android so there's only one prompt.
  event.preventDefault();
  deferred = event as InstallPromptEvent;
  notify();
});

window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

export function InstallPrompt() {
  const [event, setEvent] = useState(deferred);
  const [dismissed, setDismissed] = useState(wasDismissed);

  useEffect(() => {
    const update = () => setEvent(deferred);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);

  if (dismissed || standalone) return null;

  const dismiss = () => {
    rememberDismissed();
    setDismissed(true);
  };

  if (event) {
    const install = async () => {
      // The event only works once.
      deferred = null;
      setEvent(null);
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'dismissed') dismiss();
    };
    return (
      <div className="notice-toast floating" role="status">
        <span>Install Jarvizar City Model as an app</span>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void install()}>
          Install
        </button>
        <button type="button" className="btn btn-sm" onClick={dismiss}>
          Not now
        </button>
      </div>
    );
  }

  if (ios) {
    return (
      <div className="notice-toast floating" role="status">
        <span>To install Jarvizar City Model, tap Share and then Add to Home Screen.</span>
        <button type="button" className="btn btn-sm" onClick={dismiss}>
          OK
        </button>
      </div>
    );
  }

  return null;
}
