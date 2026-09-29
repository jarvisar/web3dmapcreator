import { useId, type ReactNode } from 'react';
import { Checkbox } from './Checkbox';

interface LayerDisclosureProps {
  label: string;
  colour: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  checkLabel?: string;
  open: boolean;
  onExpand: () => void;
  summary: ReactNode;
  children: ReactNode;
}

export function LayerDisclosure({ label, colour, on, onToggle, checkLabel, open, onExpand, summary, children }: LayerDisclosureProps) {
  const bodyId = useId();
  return (
    <div className={`layer${on ? '' : ' is-off'}${open ? ' is-open' : ''}`}>
      <div className="layer-head">
        <Checkbox checked={on} onChange={onToggle} label={checkLabel ?? label} />
        <button type="button" className="layer-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onExpand}>
          <span className="dot" style={{ background: colour }} aria-hidden="true" />
          <span className="layer-name">{label}</span>
          <span className="layer-summary">{summary}</span>
          <span className="triangle" aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="layer-body" id={bodyId}>
          {children}
        </div>
      )}
    </div>
  );
}
