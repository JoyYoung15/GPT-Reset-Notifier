import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSourceJSON } from '../source-request.mjs';
import { loadSource } from '../monitor.mjs';

const snapshot = () => {
  const now = new Date().toISOString();
  return {schemaVersion:1, checkedAt:now, monitor:{status:'healthy',lastCollectedAt:now},events:[],activities:[]};
};
const networkFailure = () => new TypeError('private URL and credential must not be logged', {
  cause: Object.assign(new Error('private inner message'), {code:'UND_ERR_CONNECT_TIMEOUT'})
});
const options = () => {
  const waits = [], warnings = [];
  return {waits, warnings, sleep:async ms => {waits.push(ms);}, warn:line => {warnings.push(line);}};
};

test('connection timeout recovers once and all channels reuse the validated snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-retry-'));
  const path = join(dir, 'source.json');
  let calls = 0;
  const opts = options(), data = snapshot();
  try {
    const fetcher = async (url, init) => {
      assert.equal(url, 'https://aihot.news/api/v1/codex-resets');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.ok(init.signal instanceof AbortSignal);
      if (++calls === 1) throw networkFailure();
      return new Response(JSON.stringify(data));
    };
    assert.deepEqual(await loadSource(path, fetcher, opts), data);
    for (let channel = 0; channel < 3; channel++) {
      assert.deepEqual(await loadSource(path, () => {throw Error('unexpected refetch');}), data);
    }
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data);
    assert.equal(calls, 2);
    assert.deepEqual(opts.waits, [2000]);
    assert.match(opts.warnings[0], /UND_ERR_CONNECT_TIMEOUT/);
    assert.doesNotMatch(opts.warnings.join('\n'), /private|credential/);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('persistent network failure is bounded, redacted and creates no usable snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-retry-fail-'));
  const path = join(dir, 'source.json');
  let calls = 0;
  const opts = options();
  try {
    await assert.rejects(loadSource(path, async () => {calls++; throw networkFailure();}, opts), {
      message:'Source network failure (UND_ERR_CONNECT_TIMEOUT); stopped after 3 attempt(s); no notification or checkpoint advance.'
    });
    assert.equal(calls, 3);
    assert.deepEqual(opts.waits, [2000,5000]);
    await assert.rejects(access(path), {code:'ENOENT'});
    assert.doesNotMatch(opts.warnings.join('\n'), /private|credential/);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('temporary upstream HTTP failures recover and respect Retry-After', async () => {
  let calls = 0;
  const opts = options();
  const result = await readSourceJSON(async () => {
    if (++calls === 1) return new Response('unavailable', {status:503, headers:{'Retry-After':'12'}});
    if (calls === 2) return new Response('bad gateway', {status:502});
    return new Response('{"recovered":true}');
  }, opts);
  assert.deepEqual(result, {recovered:true});
  assert.deepEqual(opts.waits, [12000,5000]);
});

test('rate limits, redirects, security blocks and long Retry-After do not cause immediate retries', async () => {
  for (const status of [429,403,302,566,567,503]) {
    let calls = 0;
    const opts = options();
    await assert.rejects(readSourceJSON(async () => {
      calls++;
      return new Response('private body', {status,headers:{'Retry-After':'180'}});
    }, opts), new RegExp(`Source HTTP ${status}; stopped after 1`));
    assert.equal(calls, 1);
    assert.deepEqual(opts.waits, []);
  }
});

test('invalid JSON and unhealthy or incompatible source data are not retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-validation-'));
  try {
    for (const [body, expected] of [
      ['not JSON with private data', /Source JSON invalid/],
      [JSON.stringify({...snapshot(),schemaVersion:2}), /Source schema/],
      [JSON.stringify({...snapshot(),monitor:{status:'degraded'}}), /not healthy/],
      [JSON.stringify({...snapshot(),monitor:{status:'healthy',lastCollectedAt:'2020-01-01'}}), /two hours/]
    ]) {
      let calls = 0;
      const opts = options(), path = join(dir, 'source.json');
      await assert.rejects(loadSource(path, async () => {calls++; return new Response(body);}, opts), expected);
      assert.equal(calls, 1);
      assert.deepEqual(opts.waits, []);
      await assert.rejects(access(path), {code:'ENOENT'});
    }
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('body transfer interruption retries; unknown error details never reach logs', async () => {
  let calls = 0;
  const opts = options();
  assert.deepEqual(await readSourceJSON(async () => {
    calls++;
    return calls === 1
      ? {ok:true,json:async () => {throw new TypeError('private-body-url');}}
      : new Response('{"ok":true}');
  }, opts), {ok:true});
  assert.match(opts.warnings[0], /NETWORK_ERROR/);
  assert.doesNotMatch(opts.warnings[0], /private-body-url/);
});
