import { setTimeout as delay } from 'node:timers/promises';
import { networkCode } from './source-request.mjs';

export class StateRequestError extends Error {}

// Only reads are retryable. A write may already have committed even if its
// response was lost, so POST/PUT failures always require a fresh inspection.
export async function stateRequest(url, options, label, {
  fetcher = fetch, sleep = delay, warn = console.warn
} = {}) {
  const reading = options.method === 'GET';
  const limit = reading ? 3 : 1;
  for (let attempt = 1; attempt <= limit; attempt++) {
    let response, failure, retryable = false;
    try {
      response = await fetcher(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(10000)
      });
      if (reading && response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (response.ok) return await response.json();
    } catch (error) {
      failure = error instanceof SyntaxError ? 'invalid JSON response' : `network failure (${networkCode(error)})`;
      retryable = !(error instanceof SyntaxError);
    }
    if (!failure) {
      failure = `HTTP ${response.status}`;
      retryable = [500, 502, 503, 504].includes(response.status);
      await response.body?.cancel().catch(() => {});
    }
    let waitMs = attempt * 1000;
    const retryAfter = response?.headers?.get('retry-after');
    if (retryAfter) {
      const ms = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(ms)) waitMs = Math.max(waitMs, ms);
    }
    if (!reading || !retryable || attempt === limit || waitMs > 10000) {
      throw new StateRequestError(`${label}: ${failure}; stopped after ${attempt} attempt(s).${reading ? ' Notification processing stopped.' : ' Write outcome may be uncertain; automatic retry disabled.'}`);
    }
    warn(`${label}: ${failure}; retrying state GET in ${waitMs / 1000}s (attempt ${attempt + 1}/${limit}).`);
    await sleep(waitMs);
  }
}
