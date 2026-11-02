import test from 'node:test';
import assert from 'node:assert/strict';
import { stateRequest, StateRequestError } from '../state-request.mjs';
import { githubStore, deliver } from '../monitor.mjs';

const url = 'https://api.github.com/repos/example/repo/contents/.notifier-state.json';
const label = 'GitHub state read (.notifier-state.json, GET)';
const offline = () => new TypeError('private URL token=secret', {cause:{code:'ECONNRESET'}});
const options = fetcher => {
  const waits = [], warnings = [];
  return {fetcher, waits, warnings, sleep:async ms => waits.push(ms), warn:line => warnings.push(line)};
};

test('state GET retries connection and server errors, including interrupted response bodies', async () => {
  let calls = 0;
  const opts = options(async (requested, init) => {
    assert.equal(requested, url);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (++calls === 1) throw offline();
    if (calls === 2) return {ok:true,json:async()=>{throw offline();}};
    return new Response('{"sha":"recovered"}');
  });
  assert.deepEqual(await stateRequest(url, {method:'GET'}, label, opts), {sha:'recovered'});
  assert.equal(calls, 3);
  assert.deepEqual(opts.waits, [1000,2000]);
  assert.match(opts.warnings[0], /state read.*ECONNRESET/);
  assert.doesNotMatch(opts.warnings.join('\n'), /token=|secret|https:/);
  let attempts = 0;
  const http = options(async () => ++attempts === 1
    ? new Response('', {status:503,headers:{'Retry-After':'4'}})
    : new Response('{}'));
  await stateRequest(url, {method:'GET'}, label, http);
  assert.deepEqual(http.waits, [4000]);
});

test('state GET exhaustion is bounded and reports the operation without leaking credentials', async () => {
  let calls = 0;
  const opts = options(async () => {calls++;throw offline();});
  await assert.rejects(stateRequest(url, {method:'GET'}, label, opts), error => {
    assert.ok(error instanceof StateRequestError);
    assert.match(error.message, /state read.*ECONNRESET.*3 attempt/);
    assert.doesNotMatch(error.message, /secret|token=|https:/);
    return true;
  });
  assert.equal(calls, 3);
});

test('missing state remains distinct from permissions, rate limits and invalid JSON', async () => {
  assert.equal(await stateRequest(url, {method:'GET'}, label, options(async()=>new Response('',{status:404}))), null);
  for (const [status, body, headers] of [[403,'private'],[429,'private'],[200,'invalid secret'],[503,'private',{'Retry-After':'60'}]]) {
    let calls = 0;
    const opts = options(async()=>{calls++;return new Response(body,{status,headers});});
    await assert.rejects(stateRequest(url,{method:'GET'},label,opts), StateRequestError);
    assert.equal(calls, 1);
    assert.deepEqual(opts.waits, []);
  }
});

test('state POST and PUT are never repeated after network, HTTP or body failures', async () => {
  for (const method of ['POST','PUT']) for (const failure of ['network','http','body']) {
    let calls = 0;
    const opts = options(async()=>{
      calls++;
      if (failure === 'network') throw offline();
      if (failure === 'body') return {ok:true,json:async()=>{throw offline();}};
      return new Response('private',{status:503});
    });
    await assert.rejects(stateRequest(url,{method},'GitHub state write',opts), /state write.*automatic retry disabled/);
    assert.equal(calls, 1);
    assert.deepEqual(opts.waits, []);
  }
});

test('githubStore recovers state reads but a failed reservation write prevents sending', async () => {
  const previousRepo = process.env.GITHUB_REPOSITORY, previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'example/repo';
  process.env.GITHUB_TOKEN = 'placeholder-secret';
  try {
    let reads = 0, writes = 0, sent = 0;
    const opts = options(async (requested, init) => {
      assert.equal(init.headers.Authorization, 'Bearer placeholder-secret');
      if (init.method === 'PUT') {writes++;throw offline();}
      if (++reads === 1) throw offline();
      if (requested.includes('/git/ref/')) return new Response('{"ref":"refs/heads/notifier-state"}');
      return new Response(JSON.stringify({sha:'file-sha',content:Buffer.from(JSON.stringify({version:1,budget:{used:0},handled:{}})).toString('base64')}));
    });
    const storage = await githubStore('.notifier-state.json', false, opts);
    assert.equal(reads, 3);
    await assert.rejects(deliver(storage.state, [], storage.save, async()=>{sent++;}), /GitHub state write/);
    assert.equal(writes, 1);
    assert.equal(sent, 0);
    assert.doesNotMatch(opts.warnings.join('\n'), /placeholder-secret/);
  } finally {
    if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previousRepo;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
  }
});
