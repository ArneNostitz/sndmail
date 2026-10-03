import { useState, useRef, useCallback } from "react";
import { CalendarDays, Check, ChevronDown, Plus } from "lucide-react";
import { useAccountStore, type Account } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useClickOutside } from "@/hooks/useClickOutside";
import { accountColor } from "@/constants/accountColors";

import { Tooltip } from "@/components/ui/Tooltip";
interface CalendarAccountPickerProps {
  /** Accounts that actually have a calendar — Google, CalDAV, or IMAP+CalDAV */
  accounts: Account[];
  selectedId: string | null;
  onSelect: (accountId: string) => void;
}

/**
 * Picks which account's calendars are shown.
 *
 * Deliberately independent of the mail account switcher: a CalDAV account has
 * no mailbox to switch to, and reading a second account's calendar should not
 * move the inbox out from under the user.
 */
export function CalendarAccountPicker({
  accounts,
  selectedId,
  onSelect,
}: CalendarAccountPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const allAccounts = useAccountStore((s) => s.accounts);
  const requestAddAccount = useUIStore((s) => s.requestAddAccount);

  useClickOutside(ref, () => setOpen(false));

  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setOpen(false);
    },
    [onSelect],
  );

  const handleAdd = useCallback(() => {
    setOpen(false);
    // Opens Settings > Accounts with the add-account flow already showing —
    // that is where CalDAV, the calendar-only option, lives
    requestAddAccount();
  }, [requestAddAccount]);

  // Nothing to choose between, but adding a calendar account still has to be
  // reachable from here.
  const showList = accounts.length > 0;

  return (
    <div className="relative" ref={ref}>
      <Tooltip content="Choose which account's calendar to show"><button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors max-w-[16rem]"

      >
        <CalendarDays size={15} className="shrink-0" />
        <span className="truncate">
          {selected ? selected.email : "No calendar account"}
        </span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button></Tooltip>

      {open && (
        <div className="absolute z-50 mt-1 left-0 min-w-[16rem] py-1 rounded-lg border border-border-primary bg-bg-primary shadow-lg glass-panel">
          {showList && (
            <div className="px-3 py-1.5 text-[0.625rem] font-medium text-text-tertiary uppercase tracking-wider">
              Calendars
            </div>
          )}
          {accounts.map((account) => {
            // Index within the full account list keeps colours consistent with
            // the mail switcher, where the same account is also shown
            const color = accountColor(
              account.color,
              allAccounts.findIndex((a) => a.id === account.id),
            );
            const isSelected = account.id === selectedId;
            return (
              <button
                key={account.id}
                onClick={() => handleSelect(account.id)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors ${
                  isSelected ? "bg-accent/8 text-accent" : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <span
                  className="w-1.5 h-6 rounded-full shrink-0"
                  style={{ backgroundColor: color.hex }}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate leading-tight">
                    {account.displayName || account.email.split("@")[0]}
                  </div>
                  <div className="text-xs text-text-secondary truncate leading-tight">
                    {account.email}
                    {account.provider === "caldav" && " · CalDAV"}
                  </div>
                </div>
                {isSelected && <Check size={14} className="shrink-0 text-accent" />}
              </button>
            );
          })}

          {showList && <div className="border-t border-border-primary my-1" />}

          <button
            onClick={handleAdd}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-bg-tertiary flex items-center justify-center shrink-0">
              <Plus size={14} />
            </div>
            <span>Add calendar account</span>
          </button>
        </div>
      )}
    </div>
  );
}
