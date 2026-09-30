import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockTauriFs } from "@/test/mocks";

const tauriFs = createMockTauriFs();

vi.mock("@tauri-apps/plugin-fs", () => tauriFs.mock);

/** In-memory stand-in for the OS credential store behind the keychain_* commands. */
const keychain: { value: string | null; available: boolean } = { value: null, available: true };

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (!keychain.available) throw new Error("Keychain unavailable: no credential store");
  switch (cmd) {
    case "keychain_get_key":
      return keychain.value;
    case "keychain_set_key":
      keychain.value = args?.key as string;
      return null;
    case "keychain_delete_key":
      keychain.value = null;
      return null;
    default:
      throw new Error(`Unexpected command: ${cmd}`);
  }
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string, Record<string, unknown>])) }));

const KEY_FILE = "sndmail.key";

describe("crypto", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tauriFs.store.clear();
    keychain.value = null;
    keychain.available = true;
  });

  it("encrypts and decrypts a value roundtrip", async () => {
    const { encryptValue, decryptValue } = await import("./crypto");
    const plaintext = "my-secret-api-key-12345";
    const encrypted = await encryptValue(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(":")).toHaveLength(2);

    const decrypted = await decryptValue(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const { encryptValue } = await import("./crypto");
    const plaintext = "same-value";
    const enc1 = await encryptValue(plaintext);
    const enc2 = await encryptValue(plaintext);
    expect(enc1).not.toBe(enc2);
  });

  it("decryptValue throws on invalid format", async () => {
    const { decryptValue } = await import("./crypto");
    await expect(decryptValue("not-valid")).rejects.toThrow("Invalid encrypted value format");
  });

  it("isEncrypted returns true for encrypted values", async () => {
    const { encryptValue, isEncrypted } = await import("./crypto");
    const encrypted = await encryptValue("test");
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it("isEncrypted returns false for plaintext", async () => {
    const { isEncrypted } = await import("./crypto");
    expect(isEncrypted("sk-ant-1234567890abcdef")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("just-a-regular-string")).toBe(false);
  });

  it("handles empty string encryption", async () => {
    const { encryptValue, decryptValue } = await import("./crypto");
    const encrypted = await encryptValue("");
    const decrypted = await decryptValue(encrypted);
    expect(decrypted).toBe("");
  });

  it("handles unicode content", async () => {
    const { encryptValue, decryptValue } = await import("./crypto");
    const plaintext = "Hello World! Emoji test";
    const encrypted = await encryptValue(plaintext);
    const decrypted = await decryptValue(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("uses baseDir option for FS operations", async () => {
    // The keychain is now the primary store, so the only FS access on a normal
    // launch is the check for a sndmail fallback key file.
    const { encryptValue } = await import("./crypto");

    await encryptValue("test");

    expect(tauriFs.mock.exists).toHaveBeenCalledWith(
      KEY_FILE,
      expect.objectContaining({ baseDir: 26 }),
    );
  });

  it("uses baseDir option when falling back to a key file", async () => {
    keychain.available = false;

    const { encryptValue } = await import("./crypto");
    await encryptValue("test");

    expect(tauriFs.mock.writeTextFile).toHaveBeenCalledWith(
      KEY_FILE,
      expect.any(String),
      expect.objectContaining({ baseDir: 26 }),
    );
  });

  it("reads existing key from file using baseDir", async () => {
    // Pre-seed a key in the mock store
    const mockKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
    tauriFs.store.set(KEY_FILE, mockKey);

    const { encryptValue, decryptValue } = await import("./crypto");
    const encrypted = await encryptValue("round-trip-test");

    expect(tauriFs.mock.readTextFile).toHaveBeenCalledWith(
      KEY_FILE,
      expect.objectContaining({ baseDir: 26 }),
    );

    const decrypted = await decryptValue(encrypted);
    expect(decrypted).toBe("round-trip-test");
  });

  describe("key storage", () => {
    it("stores a newly generated key in the OS keychain, not on disk", async () => {
      const { encryptValue } = await import("./crypto");
      await encryptValue("hello");

      expect(keychain.value).toBeTruthy();
      expect(tauriFs.store.has(KEY_FILE)).toBe(false);
      expect(tauriFs.mock.writeTextFile).not.toHaveBeenCalled();
    });

    it("reuses the key already present in the keychain", async () => {
      const existing = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
      keychain.value = existing;

      const { encryptValue } = await import("./crypto");
      await encryptValue("hello");

      expect(keychain.value).toBe(existing);
      expect(tauriFs.store.has(KEY_FILE)).toBe(false);
    });

    it("stores an existing sndmail fallback key in the keychain and deletes the file", async () => {
      const fallback = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
      tauriFs.store.set(KEY_FILE, fallback);

      const { encryptValue } = await import("./crypto");
      await encryptValue("hello");

      expect(keychain.value).toBe(fallback);
      expect(tauriFs.mock.remove).toHaveBeenCalledWith(KEY_FILE, expect.anything());
    });

    it("can decrypt data after storing a fallback key in the keychain", async () => {
      const fallback = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
      tauriFs.store.set(KEY_FILE, fallback);
      keychain.available = false;

      const before = await import("./crypto");
      const ciphertext = await before.encryptValue("saved-secret");

      // Now the keychain works and the same ciphertext still opens.
      vi.resetModules();
      keychain.available = true;

      const after = await import("./crypto");
      expect(await after.decryptValue(ciphertext)).toBe("saved-secret");
      expect(keychain.value).toBe(fallback);
    });

    it("falls back to a file when no credential store is available", async () => {
      keychain.available = false;

      const { encryptValue, isUsingInsecureKeyFallback } = await import("./crypto");
      await encryptValue("hello");

      expect(tauriFs.store.has(KEY_FILE)).toBe(true);
      expect(isUsingInsecureKeyFallback()).toBe(true);
    });

    it("does not report the insecure fallback when the keychain works", async () => {
      const { encryptValue, isUsingInsecureKeyFallback } = await import("./crypto");
      await encryptValue("hello");

      expect(isUsingInsecureKeyFallback()).toBe(false);
    });
  });
});
