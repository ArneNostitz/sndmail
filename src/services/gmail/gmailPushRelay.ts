import { getAllAccounts } from "../db/accounts";
import { getSetting, getSecureSetting } from "../db/settings";
import { syncAccount } from "./syncManager";
import { getGmailClient } from "./tokenManager";

let controller: AbortController | null = null;
let relayConfig: { url: string; secret: string; topicName: string } | null = null;
let relayRunId = 0;

export type GmailPushRelayRegistration = {
  email: string;
  historyId?: string;
  expiresAt?: number;
};

export type GmailPushRelayServerStatus = {
  ok: boolean;
  version: string;
  registrationCount: number;
  connectedClients: number;
  registrations: GmailPushRelayRegistration[];
  lastRegistrationAt: string | null;
  lastPubSubAt: string | null;
};

export type GmailPushRelayStatus = {
  state: "idle" | "connecting" | "connected" | "error";
  baseUrl: string | null;
  attempted: number;
  registered: GmailPushRelayRegistration[];
  failures: { email: string; message: string }[];
  server: GmailPushRelayServerStatus | null;
  error: string | null;
};

const statusListeners = new Set<(status: GmailPushRelayStatus) => void>();
let relayStatus: GmailPushRelayStatus = {
  state: "idle",
  baseUrl: null,
  attempted: 0,
  registered: [],
  failures: [],
  server: null,
  error: null,
};

function publishStatus(update: Partial<GmailPushRelayStatus>): void {
  relayStatus = { ...relayStatus, ...update };
  for (const listener of statusListeners) listener(relayStatus);
}

function relayUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Listen for Gmail history notifications from the optional snd relay. */
export async function startGmailPushRelay(): Promise<void> {
  stopGmailPushRelay();
  const runId = relayRunId;
  const configuredUrl = await getSetting("gmail_push_relay_url");
  const secret = await getSecureSetting("gmail_push_relay_secret");
  const topicName = await getSetting("gmail_push_topic_name");
  if (!configuredUrl || !secret || !topicName) return;

  const baseUrl = relayUrl(configuredUrl);
  publishStatus({ state: "connecting", baseUrl, attempted: 0, registered: [], failures: [], server: null, error: null });
  relayConfig = { url: baseUrl, secret, topicName: topicName.trim() };
  const url = `${baseUrl}/events`;
  controller = new AbortController();
  const signal = controller.signal;
  const isCurrentRun = (): boolean => runId === relayRunId && !signal.aborted;

  const register = async (account: Awaited<ReturnType<typeof getAllAccounts>>[number]): Promise<GmailPushRelayRegistration | null> => {
    if (!isCurrentRun()) return null;
    const client = await getGmailClient(account.id);
    if (!isCurrentRun()) return null;
    const accessToken = await client.getAccessToken();
    if (!isCurrentRun()) return null;
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ email: account.email, accessToken, topicName: relayConfig?.topicName }),
      signal,
    });
    if (!response.ok) throw new Error(`Relay registration returned HTTP ${response.status}`);
    return (await response.json()) as GmailPushRelayRegistration;
  };

  try {
    const accounts = await getAllAccounts();
    const gmailAccounts = accounts.filter((account) => account.provider === "gmail_api" && account.is_active);
    const registrations = await Promise.allSettled(gmailAccounts.map((account) => register(account)));
    const registered = registrations.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
    const failures = registrations.flatMap((result, index) => {
      if (result.status !== "rejected" || !gmailAccounts[index]) return [];
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      if (isCurrentRun()) console.warn("Gmail push watch registration failed:", result.reason);
      return [{ email: gmailAccounts[index].email, message }];
    });
    if (isCurrentRun()) {
      publishStatus({ attempted: gmailAccounts.length, registered, failures });
    }
    if (!isCurrentRun()) return;
    const serverStatus = await fetchRelayStatus(baseUrl, secret, signal);
    if (isCurrentRun()) publishStatus({ server: serverStatus });
    const response = await fetch(url, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${secret}` },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Relay returned HTTP ${response.status}`);
    publishStatus({ state: "connected" });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const line = event.split("\n").find((part) => part.startsWith("data: "));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(6)) as { type?: string; email?: string };
          if (!payload.email) continue;
          if (payload.type === "renew-required") {
            const accounts = await getAllAccounts();
            const account = accounts.find((item) => item.email.toLowerCase() === payload.email!.toLowerCase());
            if (account) void register(account).catch((error) => console.warn("Gmail push watch renewal failed:", error));
          } else if (payload.type === "gmail-history") {
            const accounts = await getAllAccounts();
            const account = accounts.find((item) => item.email.toLowerCase() === payload.email!.toLowerCase());
            if (account?.provider === "gmail_api" && account.is_active) void syncAccount(account.id);
          }
        } catch (error) {
          console.warn("Ignoring malformed Gmail relay event", error);
        }
      }
    }
  } catch (error) {
    if (isCurrentRun()) {
      const message = error instanceof Error ? error.message : String(error);
      publishStatus({ state: "error", error: message });
      console.warn("Gmail push relay unavailable:", error);
    }
  }
}

async function fetchRelayStatus(baseUrl: string, secret: string, signal?: AbortSignal): Promise<GmailPushRelayServerStatus> {
  const response = await fetch(`${baseUrl}/status`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${secret}` },
    signal,
  });
  if (!response.ok) throw new Error(`Relay status returned HTTP ${response.status}`);
  return (await response.json()) as GmailPushRelayServerStatus;
}

/** Probe the configured relay and publish its current registration state. */
export async function probeGmailPushRelay(): Promise<GmailPushRelayServerStatus> {
  const configuredUrl = await getSetting("gmail_push_relay_url");
  const secret = await getSecureSetting("gmail_push_relay_secret");
  if (!configuredUrl || !secret) throw new Error("Gmail push relay is not configured");
  const server = await fetchRelayStatus(relayUrl(configuredUrl), secret);
  publishStatus({ state: "connected", baseUrl: relayUrl(configuredUrl), server, error: null });
  return server;
}

export function getGmailPushRelayStatus(): GmailPushRelayStatus {
  return relayStatus;
}

export function subscribeGmailPushRelayStatus(listener: (status: GmailPushRelayStatus) => void): () => void {
  statusListeners.add(listener);
  listener(relayStatus);
  return () => statusListeners.delete(listener);
}

export function stopGmailPushRelay(): void {
  relayRunId += 1;
  controller?.abort();
  controller = null;
  relayConfig = null;
  publishStatus({ state: "idle", server: null });
}
