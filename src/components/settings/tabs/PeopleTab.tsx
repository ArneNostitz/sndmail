import { Section } from "../SettingsSection";
import { ContactEditor } from "../ContactEditor";
import { SubscriptionManager } from "../SubscriptionManager";

/** Contacts and the senders worth unsubscribing from. */
export function PeopleTab() {
  return (
    <>
      <Section title="Contacts">
        <p className="text-xs text-text-tertiary mb-3">
          Contacts are automatically added when you send or receive emails. Edit display names or remove contacts below.
        </p>
        <ContactEditor />
      </Section>

      <Section title="Subscriptions">
        <p className="text-xs text-text-tertiary mb-3">
          View all detected newsletter and promotional senders. Unsubscribe using RFC 8058 one-click POST, mailto, or browser fallback.
        </p>
        <SubscriptionManager />
      </Section>
    </>
  );
}
