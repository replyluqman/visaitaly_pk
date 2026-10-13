/**
 * Short-lived capability URLs for document bytes (docs/SECURITY.md "Documents (R2)").
 *
 * token = HMAC-SHA256(key, "<method>.<documentId>.<expiresAtEpochSeconds>")
 *
 * The signature binds the verb, the document and the expiry, so a view URL cannot be replayed
 * as an upload URL, or for another document, or after it expires. Verification uses
 * crypto.subtle.verify, which compares in constant time.
 */
const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

async function hmacKey(secret: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export type UrlMethod = 'GET' | 'PUT';
const payload = (method: UrlMethod, id: string, exp: number) => enc.encode(`${method}.${id}.${exp}`);

export async function signDocumentUrl(
  secret: string,
  method: UrlMethod,
  id: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): Promise<{ exp: number; sig: string }> {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), payload(method, id, exp));
  return { exp, sig: b64url(sig) };
}

export async function verifyDocumentUrl(
  secret: string,
  method: UrlMethod,
  id: string,
  expRaw: string | undefined,
  sigRaw: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!expRaw || !sigRaw || !/^\d{1,12}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (exp * 1000 <= nowMs) return false;
  const sig = fromB64url(sigRaw);
  if (!sig) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, payload(method, id, exp));
}
