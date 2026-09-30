import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { keepUnits } from '../lib/format';
import { placeFloating } from './floating';

interface TooltipProps {
  anchor: HTMLElement | null;
  open: boolean;
  children: ReactNode;
  /** 'right' sits beside the anchor, for a toolbar down the side. */
  placement?: 'top' | 'bottom' | 'right';
  id?: string;
}

export function Tooltip({ anchor, open, children, placement = 'top', id }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; side: string; arrow: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) {
      setPosition(null);
      return;
    }
    const box = ref.current.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const place = placeFloating(rect, { width: box.width, height: box.height }, placement === 'right' ? 'right-start' : placement, 7);
    if (place.side === 'left' || place.side === 'right') {
      const top = Math.max(8, rect.top + rect.height / 2 - box.height / 2);
      setPosition({ left: place.left, top, side: place.side, arrow: rect.top + rect.height / 2 - top });
      return;
    }
    // The box can be pushed in from the screen edge, so aim the arrow at the anchor itself.
    const arrow = Math.min(box.width - 8, Math.max(8, rect.left + rect.width / 2 - place.left));
    setPosition({ left: place.left, top: place.top, side: place.side, arrow });
  }, [open, anchor, placement, children]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="tooltip"
      data-side={position?.side}
      style={
        position
          ? ({ left: position.left, top: position.top, '--arrow-x': `${position.arrow}px` } as CSSProperties)
          : { left: -9999, top: 0, visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    document.body,
  );
}

interface HelpTipProps {
  text: string;
  /** What the help is about, for the button's accessible name. */
  label: string;
}

// A small "?" button. Hover or focus shows the text, a tap toggles it.
export function HelpTip({ text, label }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const describedBy = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (anchor && event.target instanceof Node && anchor.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Only close the tip, not the drawer it sits in.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, anchor]);

  return (
    <>
      <button
        type="button"
        ref={setAnchor}
        className="help-tip"
        aria-label={`About ${label}`}
        aria-describedby={describedBy}
        onPointerEnter={(event) => event.pointerType === 'mouse' && setOpen(true)}
        onPointerLeave={(event) => event.pointerType === 'mouse' && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      <span id={describedBy} className="sr-only">
        {text}
      </span>
      <Tooltip anchor={anchor} open={open}>
        {keepUnits(text)}
      </Tooltip>
    </>
  );
}
