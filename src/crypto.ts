import { createHash, randomBytes } from "crypto";
import { argon2id } from "hash-wasm";
import { KdfParams, PasswordConfig } from "./types";

const FILE_MAGIC = "OSGS1";
const VERIFIER_TEXT = "secure-git-sync-password-verifier-v2";
const CREDENTIAL_VERIFIER_TEXT = "secure-git-sync-credential-verifier-v3";
const DEFAULT_PBKDF2_ITERATIONS = 310000;
const DEFAULT_ARGON2ID_PARAMS: Required<KdfParams> = {
  iterations: 3,
  memoryKiB: 65536,
  parallelism: 1,
  hashLength: 32,
};
const VAULT_KEY_BYTES = 32;

export function isEncryptedPayload(bytes: Buffer): boolean {
  return bytes.subarray(0, FILE_MAGIC.length + 1).toString("utf8") === `${FILE_MAGIC}\n`;
}

export function randomId(): string {
  return randomBytes(16).toString("hex");
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString("base64");
}

export function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function createPasswordConfig(username: string, password: string, hint: string): Promise<PasswordConfig> {
  const vaultKeyBytes = randomBytes(VAULT_KEY_BYTES);
  return wrapVaultKey(username, password, hint, vaultKeyBytes, randomId());
}

export async function rewrapPasswordConfig(
  oldUsername: string,
  oldPassword: string,
  newUsername: string,
  newPassword: string,
  hint: string,
  config: PasswordConfig,
): Promise<PasswordConfig> {
  const vaultKeyBytes = await unwrapVaultKeyBytes(oldUsername, oldPassword, config);
  return wrapVaultKey(newUsername, newPassword, hint, vaultKeyBytes, config.keyId ?? randomId());
}

export async function verifyPassword(username: string, password: string, config: PasswordConfig): Promise<CryptoKey> {
  const vaultKeyBytes = await unwrapVaultKeyBytes(username, password, config);
  return importVaultKey(vaultKeyBytes);
}

export function isUsernameRequired(config: PasswordConfig): boolean {
  return config.version === 3 || Boolean(config.username);
}

export function shouldUpgradePasswordConfig(config: PasswordConfig): boolean {
  return (config.kdf ?? "PBKDF2-SHA-256") !== "Argon2id";
}

export async function encryptFileBytes(bytes: Buffer, key: CryptoKey, vaultRelativePath: string): Promise<Buffer> {
  if (isEncryptedPayload(bytes)) {
    return bytes;
  }

  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: webBytes(iv),
      additionalData: webBytes(Buffer.from(normalizePathForAad(vaultRelativePath), "utf8")),
    },
    key,
    webBytes(bytes),
  );
  const payload = {
    v: 2,
    alg: "AES-256-GCM",
    iv: toBase64(iv),
    data: toBase64(ciphertext),
  };

  return Buffer.from(`${FILE_MAGIC}\n${JSON.stringify(payload)}\n`, "utf8");
}

export async function encryptJson(value: unknown, key: CryptoKey, vaultRelativePath: string): Promise<Buffer> {
  return encryptFileBytes(Buffer.from(JSON.stringify(value, null, 2), "utf8"), key, vaultRelativePath);
}

export async function decryptFileBytes(bytes: Buffer, key: CryptoKey, vaultRelativePath: string): Promise<Buffer> {
  if (!isEncryptedPayload(bytes)) {
    return bytes;
  }

  const text = bytes.toString("utf8");
  const jsonStart = text.indexOf("\n") + 1;
  const payload = parseJson(text.slice(jsonStart));
  if (!isEncryptedPayloadBody(payload)) {
    throw new Error("Encrypted payload is invalid.");
  }
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: webBytes(fromBase64(payload.iv)),
      additionalData: webBytes(Buffer.from(normalizePathForAad(vaultRelativePath), "utf8")),
    },
    key,
    webBytes(fromBase64(payload.data)),
  );

  return Buffer.from(plain);
}

export async function decryptJson<T>(bytes: Buffer, key: CryptoKey, vaultRelativePath: string): Promise<T> {
  return parseJson<T>((await decryptFileBytes(bytes, key, vaultRelativePath)).toString("utf8"));
}

async function wrapVaultKey(username: string, password: string, hint: string, vaultKeyBytes: Uint8Array, keyId: string): Promise<PasswordConfig> {
  const salt = randomBytes(16);
  const kdfParams = { ...DEFAULT_ARGON2ID_PARAMS };
  const normalizedUsername = normalizeUsername(username);
  const wrappingKey = await deriveArgon2idAesKey(credentialSecret(normalizedUsername, password), salt, kdfParams);
  const wrappedKeyIv = randomBytes(12);
  const verifierIv = randomBytes(12);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: webBytes(wrappedKeyIv) },
    wrappingKey,
    webBytes(vaultKeyBytes),
  );
  const verifier = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: webBytes(verifierIv) },
    wrappingKey,
    webBytes(Buffer.from(CREDENTIAL_VERIFIER_TEXT, "utf8")),
  );

  return {
    version: 3,
    username: normalizedUsername,
    keyId,
    salt: toBase64(salt),
    wrappedKeyIv: toBase64(wrappedKeyIv),
    wrappedKeyCiphertext: toBase64(wrappedKey),
    verifierIv: toBase64(verifierIv),
    verifierCiphertext: toBase64(verifier),
    iterations: kdfParams.iterations,
    hint,
    kdf: "Argon2id",
    kdfParams,
    cipher: "AES-256-GCM",
  };
}

async function unwrapVaultKeyBytes(username: string, password: string, config: PasswordConfig): Promise<Buffer> {
  const salt = fromBase64(config.salt);
  const normalizedUsername = normalizeUsername(username);
  if (config.username && normalizeUsername(config.username) !== normalizedUsername) {
    throw new Error("Username or password is incorrect.");
  }
  const wrappingSecret = config.version === 3 || config.username
    ? credentialSecret(normalizedUsername, password)
    : password;
  const wrappingKey = await deriveAesKey(wrappingSecret, salt, config);

  try {
    const verifier = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: webBytes(fromBase64(config.verifierIv)) },
      wrappingKey,
      webBytes(fromBase64(config.verifierCiphertext)),
    );
    const verifierText = Buffer.from(verifier).toString("utf8");
    if (config.version === 3 && verifierText !== CREDENTIAL_VERIFIER_TEXT) {
      throw new Error("Credential verifier mismatch.");
    }
    if (config.version === 2 && verifierText !== VERIFIER_TEXT) {
      throw new Error("Password verifier mismatch.");
    }

    if ((config.version === 2 || config.version === 3) && config.wrappedKeyIv && config.wrappedKeyCiphertext) {
      const vaultKey = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: webBytes(fromBase64(config.wrappedKeyIv)) },
        wrappingKey,
        webBytes(fromBase64(config.wrappedKeyCiphertext)),
      );
      return Buffer.from(vaultKey);
    }

    return exportRawKey(wrappingKey);
  } catch {
    throw new Error("Username or password is incorrect.");
  }
}

async function importVaultKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    webBytes(bytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function exportRawKey(key: CryptoKey): Promise<Buffer> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return Buffer.from(raw);
}

async function deriveAesKey(password: string, salt: Uint8Array, config: PasswordConfig): Promise<CryptoKey> {
  if ((config.kdf ?? "PBKDF2-SHA-256") === "Argon2id") {
    return deriveArgon2idAesKey(password, salt, argon2idParams(config));
  }
  return derivePbkdf2AesKey(password, salt, config.iterations || DEFAULT_PBKDF2_ITERATIONS);
}

async function deriveArgon2idAesKey(password: string, salt: Uint8Array, params: Required<KdfParams>): Promise<CryptoKey> {
  const raw = await argon2id({
    password: Buffer.from(password, "utf8"),
    salt: webBytes(salt),
    iterations: params.iterations,
    parallelism: params.parallelism,
    memorySize: params.memoryKiB,
    hashLength: params.hashLength,
    outputType: "binary",
  });
  return importVaultKey(raw);
}

async function derivePbkdf2AesKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    webBytes(Buffer.from(password, "utf8")),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: webBytes(salt),
      iterations,
      hash: "SHA-256",
    },
    material,
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt", "decrypt"],
  );
}

function argon2idParams(config: PasswordConfig): Required<KdfParams> {
  return {
    iterations: validPositiveInteger(config.kdfParams?.iterations, config.iterations || DEFAULT_ARGON2ID_PARAMS.iterations),
    memoryKiB: validPositiveInteger(config.kdfParams?.memoryKiB, DEFAULT_ARGON2ID_PARAMS.memoryKiB),
    parallelism: validPositiveInteger(config.kdfParams?.parallelism, DEFAULT_ARGON2ID_PARAMS.parallelism),
    hashLength: validPositiveInteger(config.kdfParams?.hashLength, DEFAULT_ARGON2ID_PARAMS.hashLength),
  };
}

function validPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizePathForAad(vaultRelativePath: string): string {
  return vaultRelativePath.replace(/\\/g, "/");
}

function normalizeUsername(username: string): string {
  return username.trim();
}

function credentialSecret(username: string, password: string): string {
  return `secure-git-sync:v3\0${username}\0${password}`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isEncryptedPayloadBody(value: unknown): value is { iv: string; data: string } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { iv?: unknown }).iv === "string"
    && typeof (value as { data?: unknown }).data === "string";
}

function webBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
