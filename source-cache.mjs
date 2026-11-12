import { validate } from './monitor.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { FULL_SOURCE, RECENT_SOURCE, readSourceSnapshot, SourceRequestError } from './source-request.mjs';

export const POLL_INTERVAL = 10 * 60000;
const HISTORY_GAP = 7 * 86400000;

// The workflow's concurrency group serializes access to this shared checkpoint.
// Persist a reservation BEFORE the request so a killed runner cannot bypass it.
export async function prepareCachedSource(storage, {
  fetcher = fetch, now = Date.now, sleep = delay, warn = console.warn, log = console.log
} = {}) {
  const previous = storage.state;
  let started = now();
  if (previous && (previous.version !== 1 || !Number.isFinite(previous.nextRequestAt)
      || !['ready','pending','failed'].includes(previous.status)
      || (previous.lastSuccessAt != null && !Number.isFinite(previous.lastSuccessAt)))) {
    throw new Error('Invalid source cache; refusing to bypass polling interval.');
  }
  if (previous && started < previous.nextRequestAt) {
    // Small runner jitter should not turn a ten-minute poll into fifteen minutes.
    const remaining = previous.nextRequestAt - started;
    if (previous.status === 'ready' && remaining <= 30000) {
      await sleep(remaining);
      started = now();
    }
  }
  if (previous && started < previous.nextRequestAt) {
    if (previous.status !== 'ready') throw new Error(`Source cooldown until ${new Date(previous.nextRequestAt).toISOString()}; no source request or notification processing.`);
    const data = validate(previous.data, started);
    log(`Reusing validated source cache; next request not before ${new Date(previous.nextRequestAt).toISOString()}. This run did not fetch new posts.`);
    return data;
  }
  const source = !previous?.lastSuccessAt || started - previous.lastSuccessAt >= HISTORY_GAP ? FULL_SOURCE : RECENT_SOURCE;
  const sameSource = previous?.source === source;
  const reserved = {...previous, version:1, status:'pending', nextRequestAt:started + POLL_INTERVAL};
  await storage.save(reserved);
  let result;
  try {
    result = await readSourceSnapshot(fetcher, {
      source, now, sleep, warn,
      etag:sameSource ? previous?.etag : null, cachedData:sameSource ? previous?.data : null
    });
    validate(result.data, now());
  } catch (error) {
    const wait = error instanceof SourceRequestError ? error.retryAfterMs : 0;
    const nextRequestAt = now() + Math.max(POLL_INTERVAL, Number.isFinite(wait) ? wait : POLL_INTERVAL);
    await storage.save({...reserved, status:'failed', nextRequestAt});
    throw new Error(`${error.message} Next source request not before ${new Date(nextRequestAt).toISOString()}.`);
  }
  // Use completion time: retries and slow responses must not shorten the interval.
  const completed = now();
  await storage.save({version:1, status:'ready', source, data:result.data, etag:result.etag,
    lastSuccessAt:completed, nextRequestAt:completed + POLL_INTERVAL});
  log(`Source ${source === FULL_SOURCE ? 'full history' : 'recent'} snapshot ${result.notModified ? 'revalidated (304)' : 'downloaded'}; minimum request interval 10 minutes.`);
  return result.data;
}
