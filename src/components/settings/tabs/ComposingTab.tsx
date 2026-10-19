import { useCallback, useEffect, useState } from "react";
import { useUIStore } from "@/stores/uiStore";
import { getSetting, setSetting } from "@/services/db/settings";
import { Section } from "../SettingsSection";
import { SettingRow } from "../SettingRow";
import { SelectField } from "../SelectField";
import { ToggleRow } from "../ToggleRow";
import { SignatureEditor } from "../SignatureEditor";
import { TemplateEditor } from "../TemplateEditor";

/** Sending, read receipts, reply behaviour, signatures and templates. */
export function ComposingTab() {
  const sendAndArchive = useUIStore((s) => s.sendAndArchive);
  const setSendAndArchive = useUIStore((s) => s.setSendAndArchive);
  const defaultReplyMode = useUIStore((s) => s.defaultReplyMode);
  const setDefaultReplyMode = useUIStore((s) => s.setDefaultReplyMode);
  const markAsReadBehavior = useUIStore((s) => s.markAsReadBehavior);
  const setMarkAsReadBehavior = useUIStore((s) => s.setMarkAsReadBehavior);

  const [undoSendDelay, setUndoSendDelay] = useState("5");
  const [requestReadReceipts, setRequestReadReceipts] = useState(false);
  const [readReceiptResponse, setReadReceiptResponse] = useState<"ask" | "always" | "never">("ask");

  useEffect(() => {
    async function load() {
      setUndoSendDelay((await getSetting("undo_send_delay_seconds")) ?? "5");
      setRequestReadReceipts((await getSetting("read_receipt_request_default")) === "true");
      const receiptResponse = await getSetting("read_receipt_response");
      if (receiptResponse === "always" || receiptResponse === "never") {
        setReadReceiptResponse(receiptResponse);
      }
    }
    load();
  }, []);

  const handleUndoDelayChange = useCallback(async (value: string) => {
    setUndoSendDelay(value);
    await setSetting("undo_send_delay_seconds", value);
  }, []);

  const handleRequestReadReceiptsToggle = useCallback(async () => {
    const newVal = !requestReadReceipts;
    setRequestReadReceipts(newVal);
    await setSetting("read_receipt_request_default", newVal ? "true" : "false");
  }, [requestReadReceipts]);

  const handleReadReceiptResponseChange = useCallback(async (value: "ask" | "always" | "never") => {
    setReadReceiptResponse(value);
    await setSetting("read_receipt_response", value);
  }, []);

  return (
    <>
      <Section title="Sending">
        <SettingRow label="Undo send delay">
          <SelectField
            value={undoSendDelay}
            options={[
              { value: "5", label: "5 seconds" },
              { value: "10", label: "10 seconds" },
              { value: "30", label: "30 seconds" },
            ]}
            onChange={handleUndoDelayChange}
          />
        </SettingRow>
        <ToggleRow
          label="Send and archive"
          description="Automatically archive threads after sending a reply"
          checked={sendAndArchive}
          onToggle={() => setSendAndArchive(!sendAndArchive)}
        />
      </Section>

      <Section title="Read receipts">
        <ToggleRow
          label="Request read receipts"
          description="Ask recipients to confirm when they open your emails. Their mail client decides whether to answer."
          checked={requestReadReceipts}
          onToggle={handleRequestReadReceiptsToggle}
        />
        <SettingRow label="When a receipt is requested">
          <SelectField
            value={readReceiptResponse}
            options={[
              { value: "ask", label: "Ask me" },
              { value: "always", label: "Always send" },
              { value: "never", label: "Never send" },
            ]}
            onChange={handleReadReceiptResponseChange}
          />
        </SettingRow>
      </Section>

      <Section title="Behavior">
        <SettingRow label="Default reply action">
          <SelectField
            value={defaultReplyMode}
            options={[
              { value: "reply", label: "Reply" },
              { value: "replyAll", label: "Reply All" },
            ]}
            onChange={setDefaultReplyMode}
          />
        </SettingRow>
        <SettingRow label="Mark as read">
          <SelectField
            value={markAsReadBehavior}
            options={[
              { value: "instant", label: "Instantly" },
              { value: "2s", label: "After 2 seconds" },
              { value: "manual", label: "Manually" },
            ]}
            onChange={setMarkAsReadBehavior}
          />
        </SettingRow>
      </Section>

      <Section title="Signatures">
        <SignatureEditor />
      </Section>

      <Section title="Templates">
        <TemplateEditor />
      </Section>
    </>
  );
}
