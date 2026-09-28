interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name when there is no visible label pointing at the switch. */
  label?: string;
  id?: string;
  disabled?: boolean;
  labelledBy?: string;
  describedBy?: string;
}

export function Switch({ checked, onChange, label, id, disabled, labelledBy, describedBy }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}
