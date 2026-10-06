const IV_BYTES = 12;
const KEY_BYTES = 32;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
export function newSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
export async function importSecret(secret: string): Promise<CryptoKey> {
  const raw = decodeBase64Url(secret);
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error("Invalid transfer secret.");
  }

  const keyBuffer = new ArrayBuffer(raw.byteLength);
  new Uint8Array(keyBuffer).set(raw);

  return crypto.subtle.importKey(
    "raw",
    keyBuffer,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptChunk(key: CryptoKey, data: ArrayBuffer, index: number): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const packet = new Uint8Array(4 + IV_BYTES + ciphertext.byteLength);
  new DataView(packet.buffer).setUint32(0, index);
  packet.set(iv, 4);
  packet.set(new Uint8Array(ciphertext), 4 + IV_BYTES);
  return packet.buffer;
}
export async function decryptChunk(key: CryptoKey, packet: ArrayBuffer): Promise<{index:number; data:ArrayBuffer}> {
  const bytes = new Uint8Array(packet);
  if (bytes.byteLength < 4 + IV_BYTES + 16) throw new Error("Malformed encrypted chunk.");
  const index = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const iv = bytes.slice(4, 4 + IV_BYTES);
  const ciphertext = bytes.slice(4 + IV_BYTES);
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return { index, data };
}
export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
