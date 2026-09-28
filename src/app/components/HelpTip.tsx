import { CircleQuestionMark } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { keepUnits } from '../lib/format';
import { placeFloating } from './floating';

interface TooltipProps {
  anchor: HTMLElement | null;
  open: boolean;
  children: ReactNode;
  placement?: 'top' | 'bottom';
  id?: string;
}

export function Tooltip({ anchor, open, children, placement = 'top', id }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; side: string } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) {
      setPosition(null);
      return;
    }
    const box = ref.current.getBoundingClientRect();
    const place = placeFloating(anchor.getBoundingClientRect(), { width: box.width, height: box.height }, placement, 6);
    setPosition({ left: place.left, top: place.top, side: place.side });
  }, [open, anchor, placement, children]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="tooltip"
      data-side={position?.side}
      style={position ? { left: position.left, top: position.top } : { left: -9999, top: 0, visibility: 'hidden' }}
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
      if (event.key === 'Escape') setOpen(false);
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
        <CircleQuestionMark size={14} strokeWidth={1.75} aria-hidden="true" />
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
