/**
 * The switch itself, without a label — `ToggleRow` pairs it with one, the
 * sidebar editor drops it into a list row that carries its own label.
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: () => void;
  /** Accessible name; the visible label sits outside the control. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
        disabled ? "bg-accent/40 cursor-not-allowed" : checked ? "bg-accent" : "bg-bg-tertiary"
      } ${className}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}
