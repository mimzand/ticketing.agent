import { OllamaTokenSchema } from '@ticket/shared';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The part of Electron's safeStorage this module uses (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only. `basic_text` means no real OS keyring: treated as unavailable. */
  getSelectedStorageBackend?(): string;
}

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenStoreError';
  }
}

export const TOKEN_ENCRYPTION_UNAVAILABLE =
  'This computer cannot encrypt the token (safeStorage is unavailable), so it was not saved.';

/**
 * The Ollama access token at rest: a safeStorage-encrypted file in the app's user
 * data folder. Never SQLite, never the renderer, never a log line. Main decrypts it
 * only to hand it to the agent, which keeps it in memory.
 */
export interface TokenStore {
  encryptionAvailable(): boolean;
  /** Throws TokenStoreError when the token cannot be encrypted. Nothing is written then. */
  save(token: string): string;
  clear(): void;
  /** The decrypted token, or undefined when none is saved or it cannot be read. */
  load(): string | undefined;
}

export function createTokenStore(options: {
  readonly safeStorage: SafeStorageLike;
  readonly filePath: string;
  readonly platform?: NodeJS.Platform;
}): TokenStore {
  const { safeStorage, filePath } = options;
  const platform = options.platform ?? process.platform;

  const encryptionAvailable = (): boolean => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  };

  return {
    encryptionAvailable,
    save(raw) {
      const parsed = OllamaTokenSchema.safeParse(raw);
      if (!parsed.success) throw new TokenStoreError(parsed.error.issues[0]?.message ?? 'Invalid token.');
      if (!encryptionAvailable()) throw new TokenStoreError(TOKEN_ENCRYPTION_UNAVAILABLE);
      let encrypted: Buffer;
      try {
        encrypted = safeStorage.encryptString(parsed.data);
      } catch {
        throw new TokenStoreError(TOKEN_ENCRYPTION_UNAVAILABLE);
      }
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, encrypted, { mode: 0o600 });
      return parsed.data;
    },
    clear() {
      rmSync(filePath, { force: true });
    },
    load() {
      if (!encryptionAvailable()) return undefined;
      try {
        const token = safeStorage.decryptString(readFileSync(filePath));
        return OllamaTokenSchema.safeParse(token).success ? token : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
