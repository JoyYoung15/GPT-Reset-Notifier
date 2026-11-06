import test from 'node:test';
import assert from 'node:assert/strict';
import { stateRequest, StateRequestError, saveCheckpoint } from '../state-request.mjs';
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
    assert.equal(writes, 3);
    assert.equal(sent, 0);
    assert.doesNotMatch(opts.warnings.join('\n'), /placeholder-secret/);
  } finally {
    if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previousRepo;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
  }
});

const content = Buffer.from('checkpoint\n').toString('base64');
const checkpoint = (sha, value = content) => ({sha, content:value, encoding:'base64'});
const transient = () => new StateRequestError('GitHub state write: HTTP 500', true);

test('checkpoint verifies committed writes after 500, timeout, lost body and malformed success', async () => {
  for (const mode of ['http','timeout','body','malformed']) {
    let writes = 0, reads = 0;
    const opts = options(async () => {
      writes++;
      if (mode === 'http') return new Response('', {status:500});
      if (mode === 'timeout') throw new DOMException('private', 'TimeoutError');
      if (mode === 'body') return new Response('invalid');
      return new Response('{}');
    });
    const sha = await saveCheckpoint(
      () => stateRequest(url, {method:'PUT'}, 'GitHub state write', opts),
      async () => {reads++;return checkpoint('saved-sha');},
      'old-sha', content, 'GitHub state write', opts);
    assert.equal(sha, 'saved-sha');
    assert.equal(writes, 1);
    assert.equal(reads, 1);
    assert.doesNotMatch(opts.warnings.join('\n'), /private|token=|https:/);
  }
});

test('checkpoint retries only after verifying unchanged state and stops after three writes', async () => {
  for (const recover of [true,false]) {
    let writes = 0, reads = 0;
    const opts = options();
    const saving = saveCheckpoint(async () => {
      if (++writes < 3 || !recover) throw transient();
      return {content:{sha:'saved-sha'}};
    }, async () => {reads++;return checkpoint('old-sha', Buffer.from('old').toString('base64'));},
    'old-sha', content, 'GitHub state write', opts);
    if (recover) assert.equal(await saving, 'saved-sha');
    else await assert.rejects(saving, /not saved after 3 verified attempts/);
    assert.equal(writes, 3);
    assert.equal(reads, recover ? 2 : 3);
  }
});

test('changed, deleted or unreadable checkpoints cannot authorize a repeat write', async () => {
  for (const current of [checkpoint('other-sha', 'b3RoZXI='), null, 'unreadable']) {
    let writes = 0;
    await assert.rejects(saveCheckpoint(async () => {writes++;throw transient();}, async () => {
      if (current === 'unreadable') throw new StateRequestError('GitHub state read failed');
      return current;
    }, 'old-sha', content, 'GitHub state write', options()), /refusing to overwrite|state read failed/);
    assert.equal(writes, 1);
  }
});

test('permission and rate-limit failures do not trigger checkpoint retry', async () => {
  for (const status of [403,429,422]) {
    let writes = 0, reads = 0;
    const opts = options(async () => {writes++;return new Response('', {status});});
    await assert.rejects(saveCheckpoint(() => stateRequest(url,{method:'PUT'},'GitHub state write',opts),
      async () => {reads++;return checkpoint('old-sha');}, 'old-sha', content, 'GitHub state write', opts), new RegExp(`HTTP ${status}`));
    assert.equal(writes, 1);
    assert.equal(reads, 0);
  }
});

test('new checkpoint creation verifies absence before retry; concurrent creation is preserved', async () => {
  for (const conflict of [false,true]) {
    let writes = 0;
    const saving = saveCheckpoint(async () => {
      if (++writes === 1) throw transient();
      return {content:{sha:'created-sha'}};
    }, async () => conflict ? checkpoint('other-sha','b3RoZXI=') : null,
    undefined, content, 'GitHub state write', options());
    if (conflict) await assert.rejects(saving, /refusing to overwrite/);
    else assert.equal(await saving, 'created-sha');
    assert.equal(writes, conflict ? 1 : 2);
  }
});

test('checkpoint recovery respects short Retry-After and stops for long backoff', async () => {
  for (const seconds of [4,60]) {
    let writes = 0, reads = 0;
    const opts = options(async () => {
      writes++;
      return new Response('',{status:503,headers:{'Retry-After':String(seconds)}});
    });
    const saving = saveCheckpoint(() => stateRequest(url,{method:'PUT'},'GitHub state write',opts),
      async () => {reads++;return checkpoint('saved-sha');}, 'old-sha', content,'GitHub state write',opts);
    if (seconds === 4) {
      assert.equal(await saving,'saved-sha');
      assert.deepEqual(opts.waits,[4000]);
      assert.equal(reads,1);
    } else {
      await assert.rejects(saving,/HTTP 503/);
      assert.deepEqual(opts.waits,[]);
      assert.equal(reads,0);
    }
    assert.equal(writes,1);
  }
});

test('store retains original SHA on retry, adopts verified SHA, and sends only once', async () => {
  const previousRepo = process.env.GITHUB_REPOSITORY, previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'example/repo'; process.env.GITHUB_TOKEN = 'placeholder';
  try {
    let file = checkpoint('initial-sha', Buffer.from(JSON.stringify({budget:{used:0},handled:{},seen:{}})).toString('base64'));
    let writes = 0, sends = 0;
    const opts = options(async (requested, init) => {
      if (init.method === 'GET') return new Response(JSON.stringify(requested.includes('/git/ref/') ? {ref:'exists'} : file));
      const body = JSON.parse(init.body);
      assert.equal(body.sha, file.sha);
      writes++;
      if (writes === 1) return new Response('', {status:500}); // No commit: safe retry.
      file = checkpoint(`saved-${writes}`,body.content);
      if (writes === 2) throw offline(); // Committed reservation, lost response.
      return new Response(JSON.stringify({content:{sha:file.sha}}));
    });
    const storage = await githubStore('.notifier-state.json',false,opts);
    await deliver(storage.state,[{identity:'post:announce',fingerprint:'fp'}],storage.save,async()=>{sends++;});
    assert.equal(writes, 3);
    assert.equal(sends, 1);
    assert.equal(JSON.parse(Buffer.from(file.content,'base64')).handled.fp, 'sent');
  } finally {
    if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY=previousRepo;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN=previousToken;
  }
});
