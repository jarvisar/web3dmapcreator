interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name when there is no visible label for the box. */
  label?: string;
  id?: string;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, id, disabled }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className="checkbox"
      id={id}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
