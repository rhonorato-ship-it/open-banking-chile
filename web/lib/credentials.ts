// AES-256-GCM encryption for bank credentials.
// CREDENTIALS_SECRET must be a 64-char hex string (32 raw bytes).
// Each field gets its own random 12-byte IV.

let cachedKey: Promise<CryptoKey> | undefined;

function getSecretHex(): string {
  const hex = process.env.CREDENTIALS_SECRET;
  if (!hex) {
    throw new Error("Missing CREDENTIALS_SECRET environment variable");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) {
    throw new Error("CREDENTIALS_SECRET must be 64 hex characters (32 bytes)");
  }
  return hex;
}

function getKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    const raw = Buffer.from(getSecretHex(), "hex");
    cachedKey = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  return cachedKey;
}

export async function encrypt(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: Buffer.from(encrypted).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
  };
}

export async function decrypt(ciphertext: string, ivBase64: string): Promise<string> {
  const key = await getKey();
  const iv = Buffer.from(ivBase64, "base64");
  if (iv.length !== 12) {
    throw new Error("Invalid IV length for AES-GCM credential payload");
  }
  const data = Buffer.from(ciphertext, "base64");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
