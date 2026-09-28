import { Box, CircleQuestionMark, Map as MapIcon, SlidersHorizontal, X } from 'lucide-react';
import { GithubMark, Logo } from '../components/Icons';
import { Tooltip } from '../components/HelpTip';
import { useState } from 'react';
import { setDrawerOpen, setHelpOpen, setView, useApp } from '../state/store';

export const REPO_URL = 'https://github.com/jarvisar/web3dmapcreator';

function ViewToggle() {
  const view = useApp((state) => state.ui.view);
  const hasModel = useApp((state) => state.generation.result !== null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  return (
    <div className="view-toggle" role="group" aria-label="View">
      <button type="button" className="view-btn" aria-pressed={view === 'map'} onClick={() => setView('map')}>
        <MapIcon size={14} aria-hidden="true" />
        Map
      </button>
      <button
        ref={setAnchor}
        type="button"
        className="view-btn"
        aria-pressed={view === 'model'}
        aria-disabled={!hasModel}
        onClick={() => hasModel && setView('model')}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        <Box size={14} aria-hidden="true" />
        3D model
      </button>
      <Tooltip anchor={anchor} open={hover && !hasModel} placement="bottom">
        Generate a model first
      </Tooltip>
    </div>
  );
}

export function TopBar({ narrow }: { narrow: boolean }) {
  const drawerOpen = useApp((state) => state.ui.drawerOpen);
  return (
    <header className="topbar">
      <div className="topbar-start">
        {narrow && (
          <button
            type="button"
            className="btn btn-ghost drawer-toggle"
            // The text is hidden on small phones, so the name can't come from it.
            aria-label="Settings"
            aria-expanded={drawerOpen}
            aria-controls="sidebar"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {drawerOpen ? <X size={16} aria-hidden="true" /> : <SlidersHorizontal size={16} aria-hidden="true" />}
            <span className="drawer-toggle-text" aria-hidden="true">
              Settings
            </span>
          </button>
        )}
        <a className="brand" href="./" aria-label="Jarvizar City Model home">
          <Logo size={24} />
          <span className="brand-name">
            Jarvizar <span className="brand-light">City Model</span>
          </span>
        </a>
      </div>
      <div className="topbar-center">
        <ViewToggle />
      </div>
      <div className="topbar-end">
        <button type="button" className="btn btn-ghost topbar-help" aria-label="Help" onClick={() => setHelpOpen(true)}>
          <CircleQuestionMark size={15} aria-hidden="true" />
          <span className="topbar-label" aria-hidden="true">
            Help
          </span>
        </button>
        <a className="topbar-github" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source code on GitHub" title="Source code on GitHub">
          <GithubMark size={16} />
        </a>
      </div>
    </header>
  );
}
