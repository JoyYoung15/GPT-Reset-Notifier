import { setTimeout as delay } from 'node:timers/promises';
import { networkCode } from './source-request.mjs';

export class StateRequestError extends Error {
  constructor(message, reconcile = false, retryAfterMs = 0) {
    super(message);
    this.reconcile = reconcile;
    this.retryAfterMs = retryAfterMs;
  }
}

// Only reads are retryable. A write may already have committed even if its
// response was lost. The checkpoint layer must inspect state before retrying PUT.
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
      throw new StateRequestError(`${label}: ${failure}; stopped after ${attempt} attempt(s).${reading ? ' Notification processing stopped.' : ' Write outcome may be uncertain; automatic retry disabled.'}`,
        !reading && waitMs <= 10000 && (retryable || response?.ok || response?.status === 409), waitMs);
    }
    warn(`${label}: ${failure}; retrying state GET in ${waitMs / 1000}s (attempt ${attempt + 1}/${limit}).`);
    await sleep(waitMs);
  }
}

// Only a checkpoint PUT with its original blob SHA may be retried. Never use
// this for notification POSTs: observing a checkpoint does not prove delivery.
export async function saveCheckpoint(write, read, expectedSha, content, label, {
  sleep = delay, warn = console.warn
} = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await write();
      if (typeof result?.content?.sha !== 'string') throw new StateRequestError(`${label}: invalid write response.`, true);
      return result.content.sha;
    } catch (error) {
      if (!(error instanceof StateRequestError) || !error.reconcile) throw error;
      warn(`${error.message} Verifying checkpoint (write attempt ${attempt}/3).`);
      await sleep(Math.max(attempt * 1000, error.retryAfterMs));
      const current = await read();
      if (current && typeof current.sha === 'string' && typeof current.content === 'string'
          && current.encoding === 'base64'
          && Buffer.from(current.content, 'base64').equals(Buffer.from(content, 'base64'))) {
        warn(`${label}: intended checkpoint verified; no repeat write needed.`);
        return current.sha;
      }
      if (current ? !expectedSha || current.sha !== expectedSha : !!expectedSha) {
        throw new StateRequestError(`${label}: checkpoint changed or disappeared; refusing to overwrite concurrent state.`);
      }
      if (attempt === 3) throw new StateRequestError(`${label}: checkpoint not saved after 3 verified attempts. Last failure: ${error.message}`);
      warn(`${label}: checkpoint unchanged; retrying with original SHA.`);
    }
  }
}
