import { Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { Tooltip } from './HelpTip';

interface LockButtonProps {
  locked: boolean;
  onChange: (locked: boolean) => void;
  // What it locks, for the button's name: "the scale".
  what: string;
}

export function LockButton({ locked, onChange, what }: LockButtonProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  const label = `${locked ? 'Unlock' : 'Lock'} ${what}`;
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`btn lock-btn${locked ? ' is-locked' : ''}`}
        aria-label={label}
        aria-pressed={locked}
        onClick={() => onChange(!locked)}
        onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={(event) => event.currentTarget.matches(':focus-visible') && setHover(true)}
        onBlur={() => setHover(false)}
      >
        {locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
      </button>
      <Tooltip anchor={anchor} open={hover} placement="bottom">
        {label}
      </Tooltip>
    </>
  );
}
