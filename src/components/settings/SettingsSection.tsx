/** Shared section chrome for settings panes (SettingsPage and per-account detail). */
export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  /** Optional control rendered on the right of the section heading */
  action?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          {title}
        </h3>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
