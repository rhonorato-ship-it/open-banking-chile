// AES-256-GCM encryption for bank credentials.
// CREDENTIALS_SECRET must be a 64-char hex string (32 raw bytes).
// Each field gets its own random 12-byte IV.

function getKey(): Promise<CryptoKey> {
  const hex = process.env.CREDENTIALS_SECRET!;
  const raw = Buffer.from(hex, "hex");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
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
  const data = Buffer.from(ciphertext, "base64");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(decrypted);
}
