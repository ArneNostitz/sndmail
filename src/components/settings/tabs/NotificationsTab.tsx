import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useAccountStore } from "@/stores/accountStore";
import {
  applyNotificationsEnabled,
  getNotificationBackend,
  type NotificationBackend,
} from "@/services/notifications/notificationManager";
import { getSetting, setSetting } from "@/services/db/settings";
import { Section } from "../SettingsSection";
import { ToggleRow } from "../ToggleRow";
import { NotificationButtonsRow } from "../NotificationButtonsRow";

const CATEGORIES = ["Primary", "Updates", "Promotions", "Social", "Newsletters"] as const;

/** Which mail announces itself, and how. */
export function NotificationsTab() {
  const accounts = useAccountStore((s) => s.accounts);

  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [notificationBackend, setNotificationBackend] = useState<NotificationBackend>("off");
  const [otpDetection, setOtpDetection] = useState(true);
  const [notifyAccounts, setNotifyAccounts] = useState<Set<string>>(() => new Set());
  const [smartNotifications, setSmartNotifications] = useState(true);
  const [notifyCategories, setNotifyCategories] = useState<Set<string>>(() => new Set(["Primary"]));
  const [vipSenders, setVipSenders] = useState<{ email_address: string; display_name: string | null }[]>([]);
  const [newVipEmail, setNewVipEmail] = useState("");

  useEffect(() => {
    async function load() {
      setNotificationsEnabled((await getSetting("notifications_enabled")) !== "false");
      setNotificationBackend(getNotificationBackend());
      setOtpDetection((await getSetting("otp_detection")) !== "false");
      const accountsSetting = await getSetting("notify_accounts");
      setNotifyAccounts(new Set(accountsSetting ? accountsSetting.split(",").filter(Boolean) : []));
      setSmartNotifications((await getSetting("smart_notifications")) !== "false");
      const notifCats = await getSetting("notify_categories");
      if (notifCats) {
        setNotifyCategories(new Set(notifCats.split(",").map((s) => s.trim()).filter(Boolean)));
      }
      try {
        const { getAllVipSenders } = await import("@/services/db/notificationVips");
        const current = useAccountStore.getState().accounts;
        const activeId = current.find((a) => a.isActive)?.id;
        if (activeId) {
          const vips = await getAllVipSenders(activeId);
          setVipSenders(vips.map((v) => ({ email_address: v.email_address, display_name: v.display_name })));
        }
      } catch {
        // VIP table may not exist yet
      }
    }
    load();
  }, []);

  const handleNotificationsToggle = useCallback(async () => {
    const newVal = !notificationsEnabled;
    setNotificationsEnabled(newVal);
    await setSetting("notifications_enabled", newVal ? "true" : "false");
    // Takes effect now, not at the next start; switching on may show the
    // system permission prompt
    await applyNotificationsEnabled(newVal);
    setNotificationBackend(getNotificationBackend());
  }, [notificationsEnabled]);

  const addVip = useCallback(async () => {
    const email = newVipEmail.trim();
    if (!email) return;
    const activeId = accounts.find((a) => a.isActive)?.id;
    if (!activeId) return;
    const { addVipSender } = await import("@/services/db/notificationVips");
    await addVipSender(activeId, email);
    setVipSenders((prev) => [...prev, { email_address: email.toLowerCase(), display_name: null }]);
    setNewVipEmail("");
  }, [accounts, newVipEmail]);

  return (
    <>
      <Section title="Notifications">
        <ToggleRow
          label="Enable notifications"
          checked={notificationsEnabled}
          onToggle={handleNotificationsToggle}
        />
        <ToggleRow
          label="Smart notifications"
          description="Only notify for selected categories and VIP senders"
          checked={smartNotifications}
          onToggle={async () => {
            const newVal = !smartNotifications;
            setSmartNotifications(newVal);
            await setSetting("smart_notifications", newVal ? "true" : "false");
          }}
        />
        {notificationsEnabled && (
          <NotificationButtonsRow backend={notificationBackend} />
        )}
      </Section>

      <Section title="One-time codes & sign-in links">
        <p className="text-xs text-text-tertiary mb-2">
          These stand on their own. A code or a sign-in link is announced
          even when every mailbox below is switched off — it is worthless
          a minute later, which is the opposite of ordinary mail.
        </p>
        <ToggleRow
          label="Detect login codes"
          description="Spot verification codes in arriving mail and copy them to the clipboard immediately"
          checked={otpDetection}
          onToggle={async () => {
            const next = !otpDetection;
            setOtpDetection(next);
            await setSetting("otp_detection", next ? "true" : "false");
          }}
        />
      </Section>

      <Section title="Which mailboxes">
        <p className="text-xs text-text-tertiary mb-2">
          Only the mailboxes you pick will notify. Pick none for silence —
          one-time codes and sign-in links come through regardless.
        </p>
        <div className="flex flex-wrap gap-2">
          {accounts.map((account) => (
            <button
              key={account.id}
              onClick={async () => {
                const next = new Set(notifyAccounts);
                if (next.has(account.id)) next.delete(account.id);
                else next.add(account.id);
                setNotifyAccounts(next);
                await setSetting("notify_accounts", [...next].join(","));
              }}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors border ${
                notifyAccounts.has(account.id)
                  ? "bg-accent/15 text-accent border-accent/30"
                  : "bg-bg-tertiary text-text-tertiary border-border-primary hover:text-text-primary"
              }`}
            >
              {account.email}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Rules">
        <p className="text-xs text-text-tertiary">
          Any mail rule can carry a <strong>Notify me</strong> action, which always
          announces a match whatever the filters above say. Build one under
          Settings → Mail rules.
        </p>
      </Section>

      {smartNotifications && (
        <>
          <Section title="Category Filters">
            <div>
              <span className="text-sm text-text-secondary">Notify for categories</span>
              <div className="flex flex-wrap gap-2 mt-2">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    onClick={async () => {
                      const next = new Set(notifyCategories);
                      if (next.has(cat)) next.delete(cat);
                      else next.add(cat);
                      setNotifyCategories(next);
                      await setSetting("notify_categories", [...next].join(","));
                    }}
                    className={`px-2.5 py-1 text-xs rounded-full transition-colors border ${
                      notifyCategories.has(cat)
                        ? "bg-accent/15 text-accent border-accent/30"
                        : "bg-bg-tertiary text-text-tertiary border-border-primary hover:text-text-primary"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          <Section title="VIP Senders">
            <p className="text-xs text-text-tertiary mb-2">
              These senders always trigger notifications regardless of category
            </p>
            <div className="space-y-1.5">
              {vipSenders.map((vip) => (
                <div key={vip.email_address} className="flex items-center justify-between py-1.5 px-3 bg-bg-secondary rounded-md">
                  <span className="text-xs text-text-primary truncate">
                    {vip.display_name ? `${vip.display_name} (${vip.email_address})` : vip.email_address}
                  </span>
                  <button
                    onClick={async () => {
                      const activeId = accounts.find((a) => a.isActive)?.id;
                      if (!activeId) return;
                      const { removeVipSender } = await import("@/services/db/notificationVips");
                      await removeVipSender(activeId, vip.email_address);
                      setVipSenders((prev) => prev.filter((v) => v.email_address !== vip.email_address));
                    }}
                    className="text-xs text-danger hover:text-danger/80 ml-2 shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <input
                type="email"
                value={newVipEmail}
                onChange={(e) => setNewVipEmail(e.target.value)}
                placeholder="email@example.com"
                aria-label="Add VIP sender"
                className="flex-1 px-3 py-1.5 bg-bg-tertiary border border-border-primary rounded-md text-xs text-text-primary outline-none focus:border-accent"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addVip();
                }}
              />
              <Button variant="primary" onClick={addVip} disabled={!newVipEmail.trim()}>
                Add
              </Button>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
