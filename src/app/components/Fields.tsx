import { useEffect, useId, useState } from 'react';
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
}

export function SelectField({ label, value, onChange, children, help, stacked }: SelectFieldProps) {
  const id = useId();
  return (
    <div className={`field${stacked ? ' field-stacked' : ''}`}>
      <div className="field-row">
        <span className="field-label">
          <label htmlFor={id}>{label}</label>
          {help && <HelpTip text={help} label={label} />}
        </span>
        {!stacked && (
          <select id={id} className="select" value={value} onChange={(event) => onChange(event.target.value)}>
            {children}
          </select>
        )}
      </div>
      {stacked && (
        <select id={id} className="select select-block" value={value} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
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

const HEX = /^#?([0-9a-f]{6})$/i;

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
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const apply = (next: string) => {
    const match = HEX.exec(next.trim());
    if (match) onChange(`#${match[1].toUpperCase()}`);
  };
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
          <input
            id={id}
            className="text-input hex-input"
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setText(event.target.value);
              apply(event.target.value);
            }}
            onBlur={() => setText(value)}
            onKeyDown={(event) => event.key === 'Enter' && apply(text)}
          />
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
