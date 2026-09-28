import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when the label is only an icon. */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  stretch?: boolean;
}

// A radio group drawn as a segmented control. Arrow keys move the selection.
export function Segmented<T extends string>({ value, options, onChange, label, size = 'md', className, stretch }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const enabled = options.filter((option) => !option.disabled);
    const index = enabled.findIndex((option) => option.value === value);
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + enabled.length) % enabled.length;
    else next = (index + 1) % enabled.length;
    const option = enabled[next];
    if (!option) return;
    onChange(option.value);
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[options.indexOf(option)]?.focus();
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={`segmented segmented-${size}${stretch ? ' segmented-stretch' : ''}${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            title={option.title}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            className="segment"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
