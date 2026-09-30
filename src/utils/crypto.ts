/**
 * Application-level AES-GCM encryption for credentials at rest.
 *
 * The key lives in the OS credential store (macOS Keychain, Windows Credential
 * Manager, Linux Secret Service) via the `keychain_*` Tauri commands.
 *
 * Earlier versions wrote the key in cleartext to `velo.key` alongside the
 * database it protects, which meant anything able to read `velo.db` could also
 * read the key. On first launch after upgrading, an existing `velo.key` is
 * migrated into the credential store and the file is deleted.
 *
 * If no credential store is reachable (e.g. headless Linux with no Secret
 * Service provider), the legacy file is used as a fallback so the app keeps
 * working — degraded, but never locked out of its own data.
 */

import {
  exists,
  readTextFile,
  writeTextFile,
  mkdir,
  remove,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

const KEY_FILE_NAME = "sndmail.key";
const LEGACY_KEY_FILE_NAME = "velo.key";
const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const FS_OPTIONS = { baseDir: BaseDirectory.AppData };

let cachedKey: CryptoKey | null = null;

/** True when the key had to be kept on disk because no OS keychain was usable. */
let usingInsecureFallback = false;

export function isUsingInsecureKeyFallback(): boolean {
  return usingInsecureFallback;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function ensureAppDataDir(): Promise<void> {
  try {
    await mkdir("", { ...FS_OPTIONS, recursive: true });
  } catch {
    // directory may already exist
  }
}

// Web Crypto API accepts BufferSource (ArrayBuffer | ArrayBufferView).
// TypeScript's ES2021 lib types are strict about Uint8Array<ArrayBufferLike> vs ArrayBufferView<ArrayBuffer>.
// This cast satisfies the type checker while passing the Uint8Array directly to the API.
function asBufferSource(arr: Uint8Array): BufferSource {
  return arr as unknown as BufferSource;
}

async function keychainGet(): Promise<string | null> {
  return (await invoke<string | null>("keychain_get_key")) ?? null;
}

async function keychainSet(key: string): Promise<void> {
  await invoke("keychain_set_key", { key });
}

/** Read the legacy plaintext key file, or null if it isn't there. */
async function readLegacyKeyFile(): Promise<string | null> {
  for (const name of [KEY_FILE_NAME, LEGACY_KEY_FILE_NAME]) {
    try {
      if (!(await exists(name, FS_OPTIONS))) continue;
      const contents = (await readTextFile(name, FS_OPTIONS)).trim();
      if (contents) return contents;
    } catch {
      // Try the older filename before deciding that no fallback key exists.
    }
  }
  return null;
}

async function deleteLegacyKeyFile(): Promise<void> {
  for (const name of [KEY_FILE_NAME, LEGACY_KEY_FILE_NAME]) {
    try {
      if (await exists(name, FS_OPTIONS)) await remove(name, FS_OPTIONS);
    } catch (err) {
      console.warn(`Could not delete ${name} after keychain migration:`, err);
    }
  }
}

async function writeFallbackKeyFile(rawKeyB64: string): Promise<void> {
  await ensureAppDataDir();
  await writeTextFile(KEY_FILE_NAME, rawKeyB64, FS_OPTIONS);
  usingInsecureFallback = true;
  console.warn(
    "No OS credential store available — the encryption key is stored on disk " +
      "in the app data directory. Anyone able to read the database can also read the key.",
  );
}

/**
 * Resolve the raw base64 key, in priority order:
 *   1. OS credential store
 *   2. legacy velo.key on disk  → migrated into the store, then deleted
 *   3. freshly generated        → written to the store (or to disk if unavailable)
 */
async function resolveRawKey(): Promise<string> {
  // 1. Already in the keychain
  try {
    const stored = await keychainGet();
    if (stored) return stored;
  } catch (err) {
    console.warn("Keychain unavailable, falling back to file-based key:", err);
    const legacy = await readLegacyKeyFile();
    if (legacy) {
      usingInsecureFallback = true;
      return legacy;
    }
    const generated = base64Encode(crypto.getRandomValues(new Uint8Array(KEY_LENGTH / 8)));
    await writeFallbackKeyFile(generated);
    return generated;
  }

  // 2. Migrate an existing plaintext key file
  const legacy = await readLegacyKeyFile();
  if (legacy) {
    try {
      await keychainSet(legacy);
      await deleteLegacyKeyFile();
      console.info("Migrated encryption key file into the OS credential store.");
    } catch (err) {
      console.warn("Could not migrate key into the keychain, leaving it on disk:", err);
      usingInsecureFallback = true;
    }
    return legacy;
  }

  // 3. First launch — generate and store
  const generated = base64Encode(crypto.getRandomValues(new Uint8Array(KEY_LENGTH / 8)));
  try {
    await keychainSet(generated);
  } catch (err) {
    console.warn("Could not store new key in the keychain:", err);
    await writeFallbackKeyFile(generated);
  }
  return generated;
}

async function getOrCreateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const rawKeyB64 = await resolveRawKey();
  const rawKey = base64Decode(rawKeyB64);

  cachedKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(rawKey),
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"],
  );

  return cachedKey;
}

/**
 * Encrypt a plaintext string. Returns a base64 string in the format: iv:ciphertext
 * (GCM tag is appended to ciphertext by the Web Crypto API)
 */
export async function encryptValue(plaintext: string): Promise<string> {
  const key = await getOrCreateKey();
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(data),
  );

  const ivB64 = base64Encode(iv);
  const ciphertextB64 = base64Encode(new Uint8Array(encrypted));
  return `${ivB64}:${ciphertextB64}`;
}

/**
 * Decrypt a value produced by encryptValue. Returns the original plaintext.
 */
export async function decryptValue(encrypted: string): Promise<string> {
  const key = await getOrCreateKey();

  const parts = encrypted.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid encrypted value format");
  }
  const [ivB64, ciphertextB64] = parts;
  if (!ivB64 || !ciphertextB64) {
    throw new Error("Invalid encrypted value format");
  }

  const iv = base64Decode(ivB64);
  const ciphertext = base64Decode(ciphertextB64);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: asBufferSource(iv) },
    key,
    asBufferSource(ciphertext),
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

/**
 * Check if a value looks like it's already encrypted (base64:base64 format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 2) return false;
  try {
    atob(parts[0]!);
    atob(parts[1]!);
    // Encrypted values have a 12-byte IV (16 chars base64) and substantial ciphertext
    return parts[0]!.length === 16;
  } catch {
    return false;
  }
}
