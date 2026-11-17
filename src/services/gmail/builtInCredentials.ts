import { getSetting, setSecureSetting, setSetting } from "../db/settings";
import { validateClientId, validateClientSecret } from "./clientCredentials";

/**
 * The Google OAuth client this build was made with, if any.
 *
 * `VITE_GOOGLE_CLIENT_ID` / `VITE_GOOGLE_CLIENT_SECRET` come from the
 * untracked `.env` at build time. Google treats an installed app's secret as
 * non-confidential — it ships inside the app either way — but it still stays
 * out of git. A malformed value is ignored rather than seeded, so a typo in
 * `.env` falls back to the setup dialog instead of a Google error page.
 */
export function builtInGoogleCredentials(
  env: Record<string, string | undefined> = import.meta.env,
): { clientId: string; clientSecret: string | null } | null {
  const clientId = env.VITE_GOOGLE_CLIENT_ID?.trim();
  if (!clientId || validateClientId(clientId)) return null;
  const secret = env.VITE_GOOGLE_CLIENT_SECRET?.trim() || null;
  if (secret && validateClientSecret(secret)) return null;
  return { clientId, clientSecret: secret };
}

/**
 * Store the built-in Google client on first run, so "Sign in with Google"
 * works without the Cloud console. A client the user entered in Settings is
 * never overwritten. Runs before the background helper attaches, since the
 * helper refreshes Gmail tokens with the stored client.
 */
export async function seedBuiltInGoogleCredentials(
  env: Record<string, string | undefined> = import.meta.env,
): Promise<boolean> {
  const builtIn = builtInGoogleCredentials(env);
  if (!builtIn) return false;
  if ((await getSetting("google_client_id"))?.trim()) return false;
  await setSetting("google_client_id", builtIn.clientId);
  if (builtIn.clientSecret) await setSecureSetting("google_client_secret", builtIn.clientSecret);
  return true;
}
