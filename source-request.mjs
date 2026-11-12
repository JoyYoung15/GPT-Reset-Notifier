import { setTimeout as delay } from 'node:timers/promises';

export const FULL_SOURCE = 'https://aihot.news/api/v1/codex-resets';
export const RECENT_SOURCE = `${FULL_SOURCE}/recent`;
export class SourceRequestError extends Error {
  constructor(message, retryAfterMs = 0) { super(message); this.retryAfterMs = retryAfterMs; }
}
const RETRYABLE_HTTP = new Set([500, 502, 503, 504, 522]);
const NETWORK_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'
]);

export function networkCode(error) {
  // Never log arbitrary error messages: they can contain URLs or credentials.
  const code = error?.cause?.code ?? error?.code;
  if (NETWORK_CODES.has(code)) return code;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  return 'NETWORK_ERROR';
}

// Retry only the public, read-only source GET. Never wrap notification POSTs or
// checkpoint writes: retrying an ambiguous send could produce duplicate alerts.
export async function readSourceJSON(fetcher = fetch, { sleep = delay, warn = console.warn } = {}) {
  return (await readSourceSnapshot(fetcher, {sleep, warn})).data;
}

export async function readSourceSnapshot(fetcher = fetch, {
  sleep = delay, warn = console.warn, source = RECENT_SOURCE, etag, cachedData, now = Date.now
} = {}) {
  if (![FULL_SOURCE, RECENT_SOURCE].includes(source)) throw new Error('Unsupported source endpoint.');
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    let data;
    let failure;
    let retryable = false;
    try {
      response = await fetcher(source, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(25000),
        headers: { 'User-Agent': 'GPT-Reset-Notifier/1.0 (+https://github.com/JoyYoung15/GPT-Reset-Notifier)',
          'Accept-Encoding': 'gzip, br', ...(etag ? {'If-None-Match':etag} : {}) }
      });
      if (response.ok) data = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Source JSON invalid; no notification or checkpoint advance.');
      }
      failure = `Source network failure (${networkCode(error)})`;
      retryable = true;
    }
    if (!failure && response.status === 304) {
      if (!etag || !cachedData) throw new SourceRequestError('Source HTTP 304 without a matching cached snapshot.');
      return {data:cachedData, etag, notModified:true};
    }
    if (!failure && response.ok) return {data, etag:response.headers?.get('etag') ?? null, notModified:false};
    if (!failure) {
      failure = `Source HTTP ${response.status}`;
      retryable = RETRYABLE_HTTP.has(response.status);
      await response.body?.cancel().catch(() => {});
    }
    let waitMs = attempt === 1 ? 2000 : 5000;
    const retryAfter = response?.headers?.get('retry-after');
    if (retryAfter) {
      const ms = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now();
      if (Number.isFinite(ms)) waitMs = Math.max(waitMs, ms);
    }
    // 429 and permanent failures stop immediately. A long server-requested wait
    // is left to the next scheduled run instead of exceeding the job deadline.
    if (!retryable || attempt === 3 || waitMs > 60000) {
      throw new SourceRequestError(`${failure}; stopped after ${attempt} attempt(s); no notification or checkpoint advance.`, waitMs);
    }
    warn(`${failure}; retrying source GET in ${waitMs / 1000}s (attempt ${attempt + 1}/3).`);
    await sleep(waitMs);
  }
}
