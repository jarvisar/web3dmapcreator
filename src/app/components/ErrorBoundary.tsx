import { Component, type ReactNode } from 'react';
import { clearSavedState } from '../state/persist';

// Anything that throws while rendering ends up here instead of a blank page.
// Saved settings are the most likely cause that survives a reload, so there's
// a button to clear them.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash-card floating">
          <h1>Something went wrong</h1>
          <p>{error.message}</p>
          <p className="muted">Resetting clears the settings saved in this browser. Your edits and picked roads are kept aside, to put back from Edit the model or Pick roads. Downloaded map data is kept.</p>
          <div className="crash-buttons">
            <button type="button" className="btn" onClick={() => location.reload()}>
              Reload
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                clearSavedState();
                location.replace(location.pathname + location.search);
              }}
            >
              Reset settings and reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
