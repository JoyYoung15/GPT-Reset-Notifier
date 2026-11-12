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

test('production preparation persists its source cache and writes the validated shared snapshot', async () => {
  const dir=await mkdtemp(join(tmpdir(),'source-persistent-'));
  const path=join(dir,'source.json');
  try {
    const mock=`let writes=0,requests=0;
      globalThis.fetch=async(url,init)=>{
        if(url.startsWith('https://api.github.com/')) {
          if(init.method==='PUT') { writes++; return new Response(JSON.stringify({content:{sha:'saved-'+writes}})); }
          if(url.includes('/git/ref/')) return new Response('{}');
          return new Response('',{status:404});
        }
        if(writes!==1) throw Error('source requested before reservation');
        requests++;
        const now=new Date().toISOString();
        return new Response(JSON.stringify({schemaVersion:1,checkedAt:now,monitor:{status:'healthy',lastCollectedAt:now},events:[],activities:[]}));
      };
      process.on('exit',()=>{if(writes!==2||requests!==1)process.exitCode=9;});`;
    const result=spawnSync(process.execPath,['--import',
      `data:text/javascript,${encodeURIComponent(mock)}`,fileURLToPath(entry)],
    {env:{...process.env,SOURCE_CACHE:'github',SOURCE_SNAPSHOT:path,GITHUB_REPOSITORY:'example/repo',GITHUB_TOKEN:'placeholder'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/full history snapshot downloaded/);
    assert.equal(JSON.parse(await readFile(path,'utf8')).schemaVersion,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('delayed source prepares all channels with a visible warning, while stale delayed data fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-delayed-'));
  try {
    for (const stale of [false, true]) {
      const path = join(dir, `${stale}.json`);
      const result = run(path, `globalThis.fetch = async () => {
        const now = new Date().toISOString();
        return new Response(JSON.stringify({schemaVersion:1,checkedAt:now,
          monitor:{status:'delayed',lastCollectedAt:new Date(Date.now()-${stale ? 3 * 3600000 : 0}).toISOString()},events:[],activities:[]}));
      };`);
      if (stale) {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /two hours/);
        await assert.rejects(access(path), {code:'ENOENT'});
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /::warning::Source monitor delayed/);
        assert.match(result.stderr, /not a completed scan/);
        assert.match(result.stdout, /Shared source validated/);
        for (let channel=0; channel<3; channel++) {
          assert.equal((await loadSource(path, () => {throw Error('unexpected refetch');})).monitor.status, 'delayed');
        }
      }
    }
  } finally { await rm(dir, {recursive:true,force:true}); }
});

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

test('attention source preparation succeeds with a warning and retains its status in the shared snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-attention-'));
  const path = join(dir,'source.json');
  try {
    const result = run(path, `globalThis.fetch = async () => {
      const now = new Date().toISOString();
      return new Response(JSON.stringify({schemaVersion:1,checkedAt:now,
        monitor:{status:'attention',lastCollectedAt:now,reviewCount:1},events:[],activities:[]}));
    };`);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stderr,/Source monitor attention/);
    assert.match(result.stdout,/Shared source validated/);
    assert.equal(JSON.parse(await readFile(path,'utf8')).monitor.status,'attention');
    for (let channel=0;channel<3;channel++) {
      assert.equal((await loadSource(path,()=>{throw Error('unexpected refetch');})).monitor.status,'attention');
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
