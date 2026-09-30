import { useState } from 'react';
import type { ReactNode } from 'react';
import { Tooltip } from './HelpTip';

interface ToolButtonProps {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  /** Where the tooltip goes: below, or beside a toolbar down the side. */
  placement?: 'bottom' | 'right';
  children: ReactNode;
}

// An icon button in a floating toolbar, with its name in a tooltip.
export function ToolButton({ label, onClick, pressed, disabled, placement = 'bottom', children }: ToolButtonProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [hover, setHover] = useState(false);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="tool-btn"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={() => {
          setHover(false);
          onClick();
        }}
        onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocus={(event) => event.currentTarget.matches(':focus-visible') && setHover(true)}
        onBlur={() => setHover(false)}
      >
        {children}
      </button>
      <Tooltip anchor={anchor} open={hover} placement={placement}>
        {label}
      </Tooltip>
    </>
  );
}
