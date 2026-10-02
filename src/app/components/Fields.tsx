import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Checkbox } from './Checkbox';
import { HelpTip } from './HelpTip';

interface CheckFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  help?: string;
  disabled?: boolean;
}

export function CheckField({ label, checked, onChange, help, disabled }: CheckFieldProps) {
  const id = useId();
  return (
    <div className={`field check-field${disabled ? ' is-disabled' : ''}`}>
      <label className="check-label" htmlFor={id}>
        <Checkbox id={id} checked={checked} onChange={onChange} disabled={disabled} />
        {label}
      </label>
      {help && <HelpTip text={help} label={label} />}
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  help?: string;
}

export function SliderField({ label, value, onChange, min, max, step, format, help }: SliderFieldProps) {
  const id = useId();
  const progress = ((value - min) / (max - min)) * 100;
  return (
    <div className="field">
      <div className="field-row">
        <span className="field-label">
          <label htmlFor={id}>{label}</label>
          {help && <HelpTip text={help} label={label} />}
        </span>
        <span className="slider-value">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        style={{ '--progress': `${progress}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  help?: string;
  stacked?: boolean;
  /** A line under the field, read out with it. */
  hint?: ReactNode;
}

export function SelectField({ label, value, onChange, children, help, stacked, hint }: SelectFieldProps) {
  const id = useId();
  const hintId = useId();
  const select = (
    <select id={id} className={stacked ? 'select select-block' : 'select'} value={value} aria-describedby={hint ? hintId : undefined} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  );
  return (
    <div className={`field${stacked ? ' field-stacked' : ''}`}>
      <div className="field-row">
        <span className="field-label">
          <label htmlFor={id}>{label}</label>
          {help && <HelpTip text={help} label={label} />}
        </span>
        {!stacked && select}
      </div>
      {stacked && select}
      {hint && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  help?: string;
  /** Wait for Enter or blur, for values that are expensive to apply half typed, like a URL. */
  commitOnBlur?: boolean;
}

export function TextField({ label, value, onChange, placeholder, help, commitOnBlur }: TextFieldProps) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onChange(text);
  };
  return (
    <div className="field field-stacked">
      <div className="field-row">
        <span className="field-label">
          <label htmlFor={id}>{label}</label>
          {help && <HelpTip text={help} label={label} />}
        </span>
      </div>
      <input
        id={id}
        className="text-input"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setText(event.target.value);
          if (!commitOnBlur) onChange(event.target.value);
        }}
        onBlur={commitOnBlur ? commit : undefined}
        onKeyDown={commitOnBlur ? (event) => event.key === 'Enter' && commit() : undefined}
      />
    </div>
  );
}

/** #RRGGBB from a typed hex code, with or without #, three-digit shorthand too. */
export function normaliseHex(text: string): string | null {
  let value = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) value = value.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toUpperCase()}` : null;
}

interface HexInputProps {
  id?: string;
  /** #RRGGBB */
  value: string;
  onChange: (hex: string) => void;
}

// A hex code to type. A full six digits shows as you type, but the text is
// yours until you leave the field or press Enter: three digits are also a
// colour (abc is #AABBCC), and applying them then swapped the rest of what
// was being typed for the expanded code.
export function HexInput({ id, value, onChange }: HexInputProps) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const typed = useRef(false);
  // Focused but not typed in, it still follows the value, which an undo can change.
  useEffect(() => {
    if (!focused.current || !typed.current) setText(value);
  }, [value]);
  const settle = () => {
    const hex = normaliseHex(text);
    if (hex && hex !== value) onChange(hex);
    setText(hex ?? value);
    typed.current = false;
  };
  // A click outside closes the colour popover before the field loses focus,
  // and a removed field never blurs, so what was typed is applied here.
  const latest = useRef({ text, value, onChange });
  useEffect(() => {
    latest.current = { text, value, onChange };
  });
  useEffect(
    () => () => {
      if (!focused.current) return;
      const hex = normaliseHex(latest.current.text);
      if (hex && hex !== latest.current.value) latest.current.onChange(hex);
    },
    [],
  );
  return (
    <input
      id={id}
      className="text-input hex-input"
      value={text}
      spellCheck={false}
      autoComplete="off"
      onFocus={() => {
        focused.current = true;
        typed.current = false;
      }}
      onChange={(event) => {
        typed.current = true;
        setText(event.target.value);
        if (/^#?[0-9a-f]{6}$/i.test(event.target.value.trim())) onChange(normaliseHex(event.target.value)!);
      }}
      onBlur={() => {
        focused.current = false;
        settle();
      }}
      onKeyDown={(event) => event.key === 'Enter' && settle()}
    />
  );
}

interface ColourFieldProps {
  label: string;
  /** #RRGGBB */
  value: string;
  onChange: (hex: string) => void;
  help?: string;
}

// The browser's own colour picker, plus the hex code to type or copy.
export function ColourField({ label, value, onChange, help }: ColourFieldProps) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-row">
        <span className="field-label">
          <label htmlFor={id}>{label}</label>
          {help && <HelpTip text={help} label={label} />}
        </span>
        <span className="colour-field">
          <input
            type="color"
            className="colour-native"
            value={value.toLowerCase()}
            aria-label={`${label}, colour picker`}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
          />
          <HexInput id={id} value={value} onChange={onChange} />
        </span>
      </div>
    </div>
  );
}

interface DisclosureProps {
  label: string;
  children: ReactNode;
}

// Extra settings tucked under a link, shown indented when open.
export function Disclosure({ label, children }: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="disclosure-block">
      <button type="button" className="disclosure" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="triangle" aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div className="nested" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}
