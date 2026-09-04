/**
 * Verifying a Svix-signed webhook.
 *
 * Surense delivers its webhooks through Svix, which does not send an
 * Authorization header — it signs the body instead. Verifying that signature
 * is what proves a delivery really came from Surense and was not forged by
 * anyone who learned the public URL.
 *
 * The scheme: HMAC-SHA256 over `{id}.{timestamp}.{body}` using the endpoint's
 * signing secret, base64-encoded. Implemented here rather than pulled in
 * because it is thirty lines and the project otherwise has one dependency.
 *
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a delivery's timestamp may be from now, in seconds. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Reads the signature headers, accepting both the Svix names and the
 * standard-webhooks names Svix also sends.
 *
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {{id: string, timestamp: string, signature: string}}
 */
export function readSignatureHeaders(headers) {
  const pick = (...names) => {
    for (const name of names) {
      const value = headers[name];
      if (value) return Array.isArray(value) ? value[0] : value;
    }
    return '';
  };

  return {
    id: pick('svix-id', 'webhook-id'),
    timestamp: pick('svix-timestamp', 'webhook-timestamp'),
    signature: pick('svix-signature', 'webhook-signature')
  };
}

/**
 * Checks a Svix signature.
 *
 * @param {object} input
 * @param {import('node:http').IncomingHttpHeaders} input.headers
 * @param {string} input.rawBody   The body exactly as received — re-serialized
 *   JSON will not match, since key order and spacing would differ.
 * @param {string} input.secret    The endpoint's signing secret, `whsec_...`.
 * @param {number} [input.nowSeconds]
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifySvixSignature({ headers, rawBody, secret, nowSeconds }) {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };

  const { id, timestamp, signature } = readSignatureHeaders(headers);

  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'missing svix-id, svix-timestamp or svix-signature' };
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: 'timestamp is not a number' };

  // Without this a signature captured once could be replayed forever.
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - sent) > TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp is ${Math.abs(now - sent)}s away from now` };
  }

  // The secret is base64 after the prefix; older endpoints omit the prefix.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  // The header carries space-separated versioned signatures, and more than
  // one while a secret is being rotated. Any match is a pass.
  const candidates = String(signature).split(' ')
    .map(part => part.split(',').at(-1))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (equalConstantTime(candidate, expected)) return { ok: true };
  }

  return { ok: false, reason: 'no signature matched' };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function equalConstantTime(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
