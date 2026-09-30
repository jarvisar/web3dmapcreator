import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface ConfirmButtonProps {
  className: string;
  /** Added while it waits for the second click. */
  confirmingClass?: string;
  /** What it says while it waits. */
  confirm: ReactNode;
  onConfirm: () => void;
  title?: string;
  children: ReactNode;
}

// A button that does something hard to take back only on a second click
// within four seconds. The first one changes what it says.
export function ConfirmButton({ className, confirmingClass, confirm, onConfirm, title, children }: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={confirming && confirmingClass ? `${className} ${confirmingClass}` : className}
      title={title}
      onClick={() => {
        if (!confirming) {
          setConfirming(true);
          timer.current = window.setTimeout(() => setConfirming(false), 4000);
          return;
        }
        window.clearTimeout(timer.current);
        setConfirming(false);
        onConfirm();
      }}
    >
      {confirming ? confirm : children}
    </button>
  );
}
