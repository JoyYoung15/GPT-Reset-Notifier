import { loadSource } from './monitor.mjs';

// Fetch and validate once before any channel starts. A failure skips all channels,
// so they cannot refetch the same bad response and trigger upstream rate limits.
if (!process.env.SOURCE_SNAPSHOT) {
  console.error('Set SOURCE_SNAPSHOT before preparing the shared source.');
  process.exitCode = 1;
} else {
  await loadSource().then(
    () => console.log('Shared source validated; notification channels may proceed.'),
    error => { console.error(error.message); process.exitCode = 1; }
  );
}
