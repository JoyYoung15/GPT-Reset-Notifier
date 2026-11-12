import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareCachedSource, POLL_INTERVAL } from '../source-cache.mjs';
import { FULL_SOURCE, RECENT_SOURCE, readSourceSnapshot } from '../source-request.mjs';
import { plan, signals } from '../monitor.mjs';

const initial = Date.parse('2026-11-12T10:00:00Z');
const data = time => ({schemaVersion:1,checkedAt:new Date(time).toISOString(),
  monitor:{status:'healthy',lastCollectedAt:new Date(time).toISOString()},events:[],activities:[]});
function harness() {
  let time=initial;
  const logs=[], waits=[], writes=[];
  const storage={state:null, async save(value){this.state=structuredClone(value);writes.push(this.state);}};
  const opts={now:()=>time,log:line=>logs.push(line),warn:line=>logs.push(line),sleep:async ms=>{waits.push(ms);time+=ms;}};
  return {storage,opts,logs,waits,writes,advance:ms=>{time+=ms;},get time(){return time;}};
}

test('persisted cache limits independent five-minute runs and uses recent conditional requests', async () => {
  const h=harness(); let calls=0;
  const fetcher=async (url,init)=>{
    calls++;
    assert.equal(h.storage.state.status,'pending'); // Reservation precedes request.
    assert.equal(init.headers['Accept-Encoding'],'gzip, br');
    if(calls===1) assert.equal(url,FULL_SOURCE);
    else assert.equal(url,RECENT_SOURCE);
    if(calls<3) {
      assert.equal(init.headers['If-None-Match'],undefined); // Never reuse a full-history ETag for recent.
      return new Response(JSON.stringify(data(h.time)),{headers:{ETag:'"version"'}});
    }
    assert.equal(init.headers['If-None-Match'],'"version"');
    return new Response(null,{status:304});
  };
  const run=()=>prepareCachedSource(h.storage,{...h.opts,fetcher});
  await run();
  h.advance(5*60000); await run(); assert.equal(calls,1);
  h.advance(5*60000); await run(); assert.equal(calls,2);
  h.advance(POLL_INTERVAL); const reused=await run(); assert.equal(calls,3);
  assert.equal(reused.checkedAt,new Date(initial+POLL_INTERVAL).toISOString());
  assert.ok(h.logs.some(line=>line.includes('revalidated (304)')));
});

test('429 and Retry-After persist across runs; old cached data is not used to hide failure', async () => {
  for (const header of ['1200',new Date(initial+1200000).toUTCString(),null]) {
    const h=harness(); let calls=0;
    h.storage.state={version:1,status:'ready',source:RECENT_SOURCE,data:data(initial),lastSuccessAt:initial-1200000,nextRequestAt:initial-1};
    const headers=header?{'Retry-After':header}:{};
    const opts={...h.opts,fetcher:async()=>{calls++;return new Response('',{status:429,headers});}};
    await assert.rejects(prepareCachedSource(h.storage,opts),/Source HTTP 429/);
    const expected=header?1200000:POLL_INTERVAL;
    assert.equal(h.storage.state.nextRequestAt,initial+expected);
    assert.deepEqual(h.storage.state.data,data(initial));
    h.advance(5*60000);
    await assert.rejects(prepareCachedSource(h.storage,opts),/Source cooldown/);
    assert.equal(calls,1);
    h.advance(expected-5*60000);
    await prepareCachedSource(h.storage,{...h.opts,fetcher:async()=>new Response(JSON.stringify(data(h.time)))});
    assert.equal(h.storage.state.status,'ready');
  }
});

test('reservation failure prevents requests and an interrupted reservation enforces cooldown', async () => {
  const h=harness(); let calls=0;
  const fetcher=async()=>{calls++;return new Response(JSON.stringify(data(h.time)));};
  await assert.rejects(prepareCachedSource({state:null,save:async()=>{throw Error('state write failed');}},
    {...h.opts,fetcher}),/state write failed/);
  assert.equal(calls,0);
  h.storage.state={version:1,status:'pending',nextRequestAt:initial+POLL_INTERVAL};
  await assert.rejects(prepareCachedSource(h.storage,{...h.opts,fetcher}),/cooldown/);
  assert.equal(calls,0);
});

test('invalid source and stale 304 never replace valid snapshots or advance notification checkpoints', async () => {
  const h=harness();
  const original=data(initial-3*3600000);
  h.storage.state={version:1,status:'ready',source:RECENT_SOURCE,etag:'"old"',data:original,lastSuccessAt:initial-1000000,nextRequestAt:initial-1};
  await assert.rejects(prepareCachedSource(h.storage,{...h.opts,fetcher:async()=>new Response(null,{status:304})}),/two hours/);
  assert.deepEqual(h.storage.state.data,original);
  assert.equal(h.storage.state.status,'failed');
  await assert.rejects(readSourceSnapshot(async()=>new Response(null,{status:304})),/without a matching cached snapshot/);
  h.advance(POLL_INTERVAL);
  await assert.rejects(prepareCachedSource(h.storage,{...h.opts,fetcher:async()=>new Response('{"schemaVersion":2}')}),/Source schema/);
  assert.deepEqual(h.storage.state.data,original);
});

test('long outages use full history, recover new signals and preserve notification deduplication', async () => {
  const h=harness(); const before=data(initial);
  const previous=plan(before,null,initial).state;
  h.storage.state={version:1,status:'ready',source:RECENT_SOURCE,data:before,etag:'"recent"',lastSuccessAt:initial,nextRequestAt:initial+POLL_INTERVAL};
  h.advance(8*86400000);
  const after=data(h.time);
  after.events=[{id:'event'}];
  after.activities=[{id:'123',url:'https://x.com/thsottiaux/status/123',publishedAt:new Date(initial+86400000).toISOString(),
    kind:'event_update',action:'announce',eventIds:['event'],originalText:'Reset tomorrow',text:null}];
  const recovered=await prepareCachedSource(h.storage,{...h.opts,fetcher:async(url,init)=>{
    assert.equal(url,FULL_SOURCE); assert.equal(init.headers['If-None-Match'],undefined);
    return new Response(JSON.stringify(after));
  }});
  assert.equal(plan(recovered,previous,h.time).pending.length,1);
  const item=signals(recovered)[0]; previous.seen[item.identity]=item.fingerprint;
  assert.equal(plan(recovered,previous,h.time).pending.length,0);
});

test('small scheduler jitter waits until eligible; retries cannot shorten the next interval', async () => {
  const h=harness();
  h.storage.state={version:1,status:'ready',source:RECENT_SOURCE,data:data(initial),lastSuccessAt:initial,nextRequestAt:initial+1000};
  let calls=0;
  await prepareCachedSource(h.storage,{...h.opts,fetcher:async()=>{
    if(++calls===1) return new Response('',{status:503,headers:{'Retry-After':'12'}});
    return new Response(JSON.stringify(data(h.time)));
  }});
  assert.deepEqual(h.waits,[1000,12000]);
  assert.equal(h.storage.state.nextRequestAt,h.time+POLL_INTERVAL);
});

test('workflow enables persistent source cache only for preparation, with repository token', async () => {
  const workflow=await readFile(new URL('../.github/workflows/wechat.yml',import.meta.url),'utf8');
  const preparation=workflow.split('- name: Prepare shared source')[1].split('- name: Check source')[0];
  assert.match(preparation,/SOURCE_CACHE: github/);
  assert.match(preparation,/GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(workflow,/group: wechat-reset-monitor/);
});
