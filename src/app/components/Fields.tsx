import { useId } from 'react';
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
