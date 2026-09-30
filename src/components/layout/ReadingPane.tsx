import { ThreadView } from "../email/ThreadView";
import { useThreadStore } from "@/stores/threadStore";
import { useLinkedAccountId, useSelectedThreadId } from "@/hooks/useRouteNavigation";
import { EmptyState } from "../ui/EmptyState";
import { ReadingPaneIllustration } from "../ui/illustrations";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { useUIStore } from "@/stores/uiStore";
import { DetailsPlaceholder } from "../email/ContactSidebar";

export function ReadingPane() {
  const contactSidebarVisible = useUIStore((s) => s.contactSidebarVisible);
  const toggleContactSidebar = useUIStore((s) => s.toggleContactSidebar);
  const selectedThreadId = useSelectedThreadId();
  const linkedAccountId = useLinkedAccountId();
  // Falls back to the detached cache so a thread opened from the contact
  // sidebar keeps rendering even as the list reloads underneath it.
  const selectedThread = useThreadStore((s) => {
    if (!selectedThreadId) return null;
    const listed = s.threadMap.get(selectedThreadId);
    const cached = s.cachedThreads.get(selectedThreadId);
    if (!linkedAccountId) return listed ?? cached ?? null;
    return listed?.accountId === linkedAccountId ? listed : cached?.accountId === linkedAccountId ? cached : null;
  });

  if (!selectedThread) {
    return (
      <div className="@container relative flex flex-1 min-w-0 bg-bg-primary">
        <div className="flex flex-1 min-w-0 flex-col">
          <EmptyState illustration={ReadingPaneIllustration} title="sndmail" subtitle="Select an email to read" />
        </div>
        {contactSidebarVisible && <DetailsPlaceholder onClose={toggleContactSidebar} />}
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-w-0 bg-bg-primary overflow-hidden">
      {/* Keyed so switching threads resets per-thread state — an open inline
          reply with text in it must not follow you to the next thread */}
      <ErrorBoundary key={`${selectedThread.accountId}:${selectedThread.id}`} name="Message">
        <ThreadView thread={selectedThread} />
      </ErrorBoundary>
    </div>
  );
}
