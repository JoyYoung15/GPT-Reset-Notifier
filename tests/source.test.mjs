import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSource } from '../monitor.mjs';

const entry = new URL('../source.mjs', import.meta.url);
const run = (snapshotPath, mock) => spawnSync(process.execPath, [
  '--import', `data:text/javascript,${encodeURIComponent(mock)}`, fileURLToPath(entry)
], {env: {...process.env, SOURCE_SNAPSHOT:snapshotPath}, encoding:'utf8'});

test('source preparation writes one snapshot reused by all three channels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-prepare-'));
  const path = join(dir, 'source.json');
  try {
    const result = run(path, `globalThis.fetch = async () => {
      const now = new Date().toISOString();
      return new Response(JSON.stringify({schemaVersion:1,checkedAt:now,
        monitor:{status:'healthy',lastCollectedAt:now},events:[],activities:[]}));
    };`);
    assert.equal(result.status, 0, result.stderr);
    const expected = JSON.parse(await readFile(path, 'utf8'));
    for (let channel = 0; channel < 3; channel++) {
      assert.deepEqual(await loadSource(path, () => {throw Error('unexpected refetch');}), expected);
    }
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('rate limits and unhealthy data fail preparation without creating a usable snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-failure-'));
  try {
    for (const [name, mock, error] of [
      ['limited', `globalThis.fetch = async () => new Response('',{status:429});`, /Source HTTP 429/],
      ['unhealthy', `globalThis.fetch = async () => new Response(JSON.stringify({schemaVersion:1,
        checkedAt:new Date().toISOString(),monitor:{status:'degraded'},events:[],activities:[]}));`, /not healthy/]
    ]) {
      const path = join(dir, name + '.json');
      const result = run(path, mock);
      assert.equal(result.status, 1);
      assert.match(result.stderr, error);
      await assert.rejects(access(path), {code:'ENOENT'});
    }
  } finally { await rm(dir, {recursive:true,force:true}); }
});
