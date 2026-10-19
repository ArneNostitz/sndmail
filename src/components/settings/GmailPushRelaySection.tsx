import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { getSecureSetting, getSetting, setSecureSetting, setSetting } from "@/services/db/settings";
import {
  backgroundWorkerOwnsSync,
  reconfigureBackgroundWorkerRelay,
} from "@/services/worker/workerClient";
import {
  getGmailPushRelayStatus,
  probeGmailPushRelay,
  startGmailPushRelay,
  subscribeGmailPushRelayStatus,
  type GmailPushRelayStatus,
} from "@/services/gmail/gmailPushRelay";
import { Section } from "./SettingsSection";

/**
 * The optional Gmail API push relay: where it lives and whether it is
 * reachable. The URL and secret stay in local settings.
 */
export function GmailPushRelaySection() {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [topicName, setTopicName] = useState("");
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<GmailPushRelayStatus>(getGmailPushRelayStatus);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => subscribeGmailPushRelayStatus(setStatus), []);

  useEffect(() => {
    async function load() {
      setUrl((await getSetting("gmail_push_relay_url")) ?? "");
      setSecret((await getSecureSetting("gmail_push_relay_secret")) ?? "");
      setTopicName((await getSetting("gmail_push_topic_name")) ?? "");
    }
    load();
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = url.trim().replace(/\/+$/, "");
    await setSetting("gmail_push_relay_url", trimmed);
    if (secret.trim()) await setSecureSetting("gmail_push_relay_secret", secret.trim());
    await setSetting("gmail_push_topic_name", topicName.trim());
    if (backgroundWorkerOwnsSync()) await reconfigureBackgroundWorkerRelay();
    else void startGmailPushRelay();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [secret, topicName, url]);

  const handleProbe = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      await probeGmailPushRelay();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProbeError(message);
    } finally {
      setProbing(false);
    }
  }, []);

  return (
    <Section title="Gmail push relay">
      <div className="space-y-3">
        <p className="text-xs text-text-tertiary">
          Optional Gmail API push relay. This is separate from Instant delivery (IMAP IDLE). The URL and secret stay in your local settings; leave them blank to use normal sync polling.
        </p>
        <TextField
          label="Relay URL"
          size="md"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-relay.example.com"
        />
        <TextField
          label="Pub/Sub topic"
          size="md"
          value={topicName}
          onChange={(e) => setTopicName(e.target.value)}
          placeholder="projects/PROJECT_ID/topics/sndmail-gmail"
        />
        <TextField
          label="Relay secret"
          size="md"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Bearer secret configured on the relay"
        />
        <div className="rounded-md border border-border-primary bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
          <div className="flex items-center justify-between gap-3">
            <span>
              Gmail relay: {status.state === "connected"
                ? "connected"
                : status.state === "connecting"
                  ? "connecting..."
                  : status.state === "error"
                    ? "error"
                    : "not checked"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleProbe}
              disabled={probing}
              icon={<RefreshCw size={13} className={probing ? "animate-spin" : ""} />}
            >
              {probing ? "Checking..." : "Check relay"}
            </Button>
          </div>
          {status.attempted > 0 && (
            <p className="mt-1">
              Watches registered: {status.registered.length}/{status.attempted}
            </p>
          )}
          {status.registered.length > 0 && (
            <p className="mt-1 text-success">
              Registered: {status.registered.map((registration) => registration.email).join(", ")}
            </p>
          )}
          {status.registered.length === 0 && status.server && status.server.registrations.length > 0 && (
            <p className="mt-1 text-success">
              Relay registered: {status.server.registrations.map((registration) => registration.email).join(", ")}
            </p>
          )}
          {status.failures.length > 0 && (
            <p className="mt-1 text-danger">
              Failed: {status.failures.map((failure) => `${failure.email} (${failure.message})`).join(", ")}
            </p>
          )}
          {status.server && (
            <p className="mt-1">
              Relay sees {status.server.registrationCount} registered watch{status.server.registrationCount === 1 ? "" : "es"} and {status.server.connectedClients} listener{status.server.connectedClients === 1 ? "" : "s"}.
            </p>
          )}
          {probeError && <p className="mt-1 text-danger">Probe failed: {probeError}</p>}
        </div>
        <Button variant="secondary" size="md" onClick={handleSave}>
          {saved ? "Saved!" : "Save relay"}
        </Button>
      </div>
    </Section>
  );
}
