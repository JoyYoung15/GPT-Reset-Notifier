import { writeFile } from 'node:fs/promises';
import { loadSource, githubStore } from './monitor.mjs';
import { prepareCachedSource } from './source-cache.mjs';

async function prepare() {
  if (process.env.SOURCE_CACHE !== 'github') return loadSource();
  const data = await prepareCachedSource(await githubStore('.source-cache.json', true));
  await writeFile(process.env.SOURCE_SNAPSHOT, JSON.stringify(data), {mode:0o600});
  return data;
}

// Fetch and validate once before any channel starts. A failure skips all channels,
// so they cannot refetch the same bad response and trigger upstream rate limits.
if (!process.env.SOURCE_SNAPSHOT) {
  console.error('Set SOURCE_SNAPSHOT before preparing the shared source.');
  process.exitCode = 1;
} else {
  await prepare().then(
    data => {
      console.log(`Source status=${data.monitor.status}; checkedAt=${new Date(data.checkedAt).toISOString()}; lastCollectedAt=${new Date(data.monitor.lastCollectedAt).toISOString()}.`);
      if (data.monitor.status === 'attention') {
        console.warn('Source monitor attention: continuing with published signals after freshness and post validation; review status is not available per post.');
      }
      if (data.monitor.status === 'delayed') {
        console.warn('::warning::Source monitor delayed: processing fresh published records; collection may be incomplete. No new qualifying signal only describes this snapshot, not a completed scan.');
      }
      console.log('Shared source validated; notification channels may proceed.');
    },
    error => { console.error(error.message); process.exitCode = 1; }
  );
}
