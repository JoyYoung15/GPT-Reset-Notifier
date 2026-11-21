import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, plan, signals, message, deliver } from '../monitor.mjs';
import { prepareCachedSource, POLL_INTERVAL } from '../source-cache.mjs';
import { RECENT_SOURCE } from '../source-request.mjs';

const start = Date.parse('2026-11-21T00:00:00Z');
const post = (author, id, action = 'announce') => ({
  author, id, url:`https://x.com/${author}/status/${id}`,
  kind:'event_update', action, eventIds:['event'],
  publishedAt:new Date(start + 60000).toISOString(),
  originalText:'Reset limits tonight.', text:'今晚重置。'
});
const snapshot = activities => ({schemaVersion:1, checkedAt:new Date(start).toISOString(),
  monitor:{status:'healthy',lastCollectedAt:new Date(start).toISOString()}, events:[{id:'event'}], activities});
const reply = {...post('ajambrosino','2123890243409752342',null),
  kind:'related', eventIds:[], originalText:'@akshaynathan_ reset?', text:'@akshaynathan_ 重置？'};

test('Andrew related replies validate without becoming reset notifications', () => {
  const before = plan(snapshot([]), null, start).state;
  const data = snapshot([reply,post('thsottiaux','123')]);
  validate(data,start+60000);
  assert.deepEqual(plan(data,before,start+60000).pending.map(p=>p.id), ['123']);
  assert.equal(signals(snapshot([reply])).length,0);
});

test('both authors produce correctly attributed signals and preserve existing fingerprints', async () => {
  const tibo = post('thsottiaux','123');
  const legacy = {...tibo}; delete legacy.author;
  const andrew = post('ajambrosino','124','confirm');
  const data = snapshot([tibo,andrew]);
  const state = plan(snapshot([]),null,start).state;
  const result = plan(data,state,start+60000);
  assert.deepEqual(result.pending.map(p=>p.author), ['thsottiaux','ajambrosino']);
  assert.equal(signals(snapshot([legacy]))[0].fingerprint,result.pending[0].fingerprint);
  const text = message(result.pending);
  assert.match(text,/\[Tibo 原帖\]\(https:\/\/x.com\/thsottiaux\/status\/123\)/);
  assert.match(text,/\[Andrew 原帖\]\(https:\/\/x.com\/ajambrosino\/status\/124\)/);
  await deliver(result.state,result.pending,async()=>{},async()=>{});
  assert.equal(plan(data,result.state,start+60000).pending.length,0);
  assert.equal(plan(snapshot([legacy,andrew]),result.state,start+60000).pending.length,0);
});

test('author support retains URL, identity and author matching checks', () => {
  const valid = post('ajambrosino','124');
  for (const change of [
    {author:'thsottiaux'}, {author:'untrusted'}, {id:'125'},
    {url:'https://x.com/untrusted/status/124'},
    {url:valid.url+'?redirect=evil'}, {url:valid.url+'/extra'},
    {url:'http://x.com/ajambrosino/status/124'},
    {url:'https://x.com.evil.example/ajambrosino/status/124'}
  ]) {
    const data = snapshot([{...valid,...change}]);
    assert.throws(()=>validate(data,start+60000),/Invalid source post/);
    assert.equal(signals(data).length,0);
  }
});

test('Andrew hints follow the same certainty rules and historical posts stay suppressed', () => {
  const hint = {...reply,originalText:'We might reset limits tomorrow.'};
  assert.equal(signals(snapshot([hint]))[0].action,'hint');
  const old = {...post('ajambrosino','125'),publishedAt:new Date(start-86400000).toISOString()};
  const state = plan(snapshot([]),null,start).state;
  assert.equal(plan(snapshot([old]),state,start).pending.length,0);
});

test('a failed source cache recovers when eligible with Andrew data and keeps deduplication', async () => {
  const before = snapshot([post('thsottiaux','123')]);
  const notificationState = plan(before,null,start+60000).state;
  const storage = {state:{version:1,status:'failed',source:RECENT_SOURCE,
    data:before,lastSuccessAt:start,nextRequestAt:start+POLL_INTERVAL},
    async save(value){this.state=structuredClone(value);}};
  const now = start+POLL_INTERVAL;
  const current = snapshot([reply,post('thsottiaux','123'),post('ajambrosino','124','confirm')]);
  let requests=0;
  const data = await prepareCachedSource(storage,{now:()=>now,log:()=>{},fetcher:async url=>{
    assert.equal(url,RECENT_SOURCE); requests++;
    return new Response(JSON.stringify(current));
  }});
  assert.equal(requests,1);
  assert.equal(storage.state.status,'ready');
  assert.deepEqual(plan(data,notificationState,now).pending.map(p=>p.id),['124']);
});
