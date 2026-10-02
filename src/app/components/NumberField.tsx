import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { formatNumber, parseDecimal } from '../lib/format';
import { HelpTip } from './HelpTip';

export interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  /** Decimals shown. Trailing zeros are dropped. */
  decimals?: number;
  unit?: string;
  /** Shown value = stored value × scale, e.g. 100 to show a fraction as a percentage. */
  scale?: number;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  describedBy?: string;
  width?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// A text input for numbers: typing commits valid values as you go, blur or
// Enter clamps and tidies, arrow keys step (Shift for ten steps).
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  decimals = 2,
  unit,
  scale = 1,
  id,
  disabled,
  ariaLabel,
  describedBy,
  width,
}: NumberInputProps) {
  const unitId = useId();
  const shown = value * scale;
  const [text, setText] = useState(() => formatNumber(shown, decimals));
  const focused = useRef(false);
  const typed = useRef(false);
  // What the field held when it was focused, for Escape.
  const before = useRef(value);

  // Focused but not typed in, it still follows the value, which an undo can change.
  useEffect(() => {
    if (focused.current && typed.current) return;
    setText(formatNumber(value * scale, decimals));
    if (focused.current) before.current = value;
  }, [value, scale, decimals]);

  function commit(next: number) {
    const clamped = clamp(next, min, max);
    const rounded = Number(clamped.toFixed(Math.max(decimals, 6)));
    onChange(rounded / scale);
    return rounded;
  }

  /** Clamps and tidies what was typed. Returns the value it leaves stored. */
  function finish(): number {
    // Untouched: keep the stored value rather than its rounded display.
    if (text === formatNumber(shown, decimals)) return value;
    const parsed = parseDecimal(text);
    if (parsed === null) {
      setText(formatNumber(shown, decimals));
      return value;
    }
    const committed = commit(parsed);
    setText(formatNumber(committed, decimals));
    return committed / scale;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      // Enter settles the value, so Escape after it has nothing to put back.
      before.current = finish();
      typed.current = false;
      return;
    }
    if (event.key === 'Escape') {
      // Typing commits as it goes, so Escape puts the old value back.
      event.preventDefault();
      if (before.current !== value) onChange(before.current);
      setText(formatNumber(before.current * scale, decimals));
      typed.current = false;
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const base = parseDecimal(text) ?? shown;
    const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
    // Step from a clean multiple so 0.07 + 0.01 does not become 0.08000000001.
    const stepped = Math.round((base + delta) / step) * step;
    const committed = commit(stepped);
    setText(formatNumber(committed, decimals));
    typed.current = false;
  }

  return (
    <span className={`number-input${disabled ? ' is-disabled' : ''}`} style={width ? { width } : undefined}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={[describedBy, unit ? unitId : null].filter(Boolean).join(' ') || undefined}
        onFocus={(event) => {
          focused.current = true;
          typed.current = false;
          before.current = value;
          event.currentTarget.select();
        }}
        onBlur={() => {
          focused.current = false;
          finish();
        }}
        onChange={(event) => {
          typed.current = true;
          setText(event.target.value);
          const parsed = parseDecimal(event.target.value);
          if (parsed !== null && parsed >= min && parsed <= max) onChange(parsed / scale);
        }}
        onKeyDown={onKeyDown}
      />
      {unit && (
        // Hidden so it isn't read twice, but the input is described by it.
        <span id={unitId} className="number-unit" aria-hidden="true">
          {unit}
        </span>
      )}
    </span>
  );
}

interface NumberFieldProps extends Omit<NumberInputProps, 'id' | 'ariaLabel'> {
  label: string;
  help?: string;
  hint?: ReactNode;
}

export function NumberField({ label, help, hint, ...input }: NumberFieldProps) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <div className="field-row">
        <span className="field-label">
          <label htmlFor={id}>{label}</label>
          {help && <HelpTip text={help} label={label} />}
        </span>
        <NumberInput id={id} describedBy={hint ? hintId : undefined} {...input} />
      </div>
      {hint && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

interface StackedNumberProps extends Omit<NumberInputProps, 'id' | 'ariaLabel'> {
  label: string;
}

/** A number with its label above it, for pairs side by side in a .size-grid. */
export function StackedNumber({ label, ...input }: StackedNumberProps) {
  const id = useId();
  return (
    <div className="size-field">
      <label htmlFor={id} className="size-label">
        {label}
      </label>
      <NumberInput id={id} {...input} />
    </div>
  );
}
