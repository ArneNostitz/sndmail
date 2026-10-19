import { ToggleSwitch } from "./ToggleSwitch";

/** A boolean setting: name, why, and the switch that flips it. */
export function ToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-sm text-text-secondary">{label}</span>
        {description && (
          <p className="text-xs text-text-tertiary mt-0.5">{description}</p>
        )}
      </div>
      <ToggleSwitch checked={checked} onChange={onToggle} label={label} className="ml-4" />
    </div>
  );
}
