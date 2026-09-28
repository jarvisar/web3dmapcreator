import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeFloating } from './floating';
import type { Placement } from './floating';

interface PopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  label: string;
  className?: string;
  role?: 'dialog' | 'menu';
  /** Element to focus on open. Defaults to the first focusable element. */
  initialFocus?: string;
}

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// Anchored floating panel. Escape and outside clicks close it, and focus goes
// back to the anchor when it was inside the popover.
export function Popover({ anchor, open, onClose, children, placement = 'bottom-start', label, className, role = 'dialog', initialFocus }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    if (!anchor || !ref.current) return;
    const panel = ref.current;
    const size = { width: panel.offsetWidth, height: panel.scrollHeight };
    const next = placeFloating(anchor.getBoundingClientRect(), size, placement, 6);
    setPosition({ left: next.left, top: next.top, maxHeight: next.maxHeight });
  }, [anchor, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const panel = ref.current;
    const target = initialFocus ? panel?.querySelector<HTMLElement>(initialFocus) : panel?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? panel)?.focus({ preventScroll: true });

    const close = (restoreFocus: boolean) => {
      const hadFocus = panel?.contains(document.activeElement);
      onCloseRef.current();
      if (restoreFocus && hadFocus) anchor?.focus({ preventScroll: true });
    };
    const onPointer = (event: PointerEvent) => {
      const node = event.target as Node;
      if (panel?.contains(node) || anchor?.contains(node)) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    };
    const onScroll = (event: Event) => {
      if (panel?.contains(event.target as Node)) return;
      place();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, anchor, place, initialFocus]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={`popover${className ? ` ${className}` : ''}`}
      style={
        position
          ? { left: position.left, top: position.top, maxHeight: position.maxHeight }
          : // Not visibility: hidden, which would stop the focus below from landing.
            { left: -9999, top: 0, opacity: 0 }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
