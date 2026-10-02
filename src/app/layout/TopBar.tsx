import { Box, CircleQuestionMark, Map as MapIcon, PenTool, Redo2, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { GithubMark, Logo } from '../components/Icons';
import { Tooltip } from '../components/HelpTip';
import { useState, type ReactNode } from 'react';
import { REDO_KEYS, UNDO_KEYS } from '../lib/browser';
import { setDrawerOpen, setHelpOpen, setView, useApp } from '../state/store';
import { redoChange, undoChange, useUndoLabels } from '../state/undo';
import { useSvgRender } from '../svgmap/render';

export const REPO_URL = 'https://github.com/jarvisar/web3dmapcreator';

function ViewToggle() {
  const view = useApp((state) => state.ui.view);
  const svg = useApp((state) => state.output === 'svg');
  const hasModel = useApp((state) => state.generation.result !== null);
  const hasSvg = useSvgRender((state) => state.result !== null);
  const ready = svg ? hasSvg : hasModel;
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
        aria-pressed={view === 'result'}
        aria-disabled={!ready}
        onClick={() => ready && setView('result')}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        {svg ? <PenTool size={14} aria-hidden="true" /> : <Box size={14} aria-hidden="true" />}
        {svg ? 'Preview' : '3D model'}
      </button>
      <Tooltip anchor={anchor} open={hover && !ready} placement="bottom">
        {svg ? 'Generate the SVG first' : 'Generate a model first'}
      </Tooltip>
    </div>
  );
}

interface HistoryButtonProps {
  label: string;
  keys: string;
  shortcuts: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}

function HistoryButton({ label, keys, shortcuts, disabled, onClick, children }: HistoryButtonProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="btn btn-ghost topbar-icon"
        aria-label={label}
        aria-keyshortcuts={shortcuts}
        disabled={disabled}
        onClick={onClick}
        onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={(event) => event.currentTarget.matches(':focus-visible') && setHover(true)}
        onBlur={() => setHover(false)}
      >
        {children}
      </button>
      <Tooltip anchor={anchor} open={hover && !disabled} placement="bottom">
        {keys ? `${label} (${keys})` : label}
      </Tooltip>
    </>
  );
}

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

// Undo and redo for the area and settings. The model editor has its own for edits.
function HistoryButtons() {
  const { undo, redo } = useUndoLabels();
  // In the editor the keys undo edits, unless the focus is in the sidebar or here.
  const editing = useApp((state) => state.ui.editMode && state.ui.view === 'result' && state.output === 'model');
  return (
    <div className="topbar-history" role="group" aria-label="Undo and redo">
      <HistoryButton
        label={undo ? `Undo ${lower(undo)}` : 'Undo'}
        keys={editing ? '' : UNDO_KEYS}
        shortcuts="Control+Z Meta+Z"
        disabled={!undo}
        onClick={() => undoChange()}
      >
        <Undo2 size={15} aria-hidden="true" />
      </HistoryButton>
      <HistoryButton
        label={redo ? `Redo ${lower(redo)}` : 'Redo'}
        keys={editing ? '' : REDO_KEYS}
        shortcuts="Control+Y Control+Shift+Z Meta+Shift+Z"
        disabled={!redo}
        onClick={() => redoChange()}
      >
        <Redo2 size={15} aria-hidden="true" />
      </HistoryButton>
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
        <HistoryButtons />
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
