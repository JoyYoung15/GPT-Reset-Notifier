import test from 'node:test';
import assert from 'node:assert/strict';
import { sendServerChan } from '../serverchan.mjs';
import { deliver, validate } from '../monitor.mjs';

test('ServerChan delivery failures are distinct, redacted and never retried', async () => {
  for (const [failure, expected] of [
    ['network', /ServerChan send network failure \(ECONNRESET\)/],
    ['http', /ServerChan send HTTP 503/],
    ['json', /ServerChan send invalid JSON/],
    ['rejected', /ServerChan send rejected \(code 40001\)/]
  ]) {
    let calls = 0, saves = 0;
    const state = {budget:{used:0},handled:{},seen:{}};
    const item = {fingerprint:'post-hash',identity:'post:confirm'};
    await assert.rejects(deliver(state,[item],async()=>{saves++;},()=>sendServerChan('SCTprivatekey','title','body',async(url,init)=>{
      calls++;
      assert.equal(init.method,'POST');
      if(failure === 'network') throw new TypeError(url,{cause:{code:'ECONNRESET'}});
      if(failure === 'http') return new Response('private key',{status:503});
      if(failure === 'json') return new Response('SCTprivatekey');
      return new Response(JSON.stringify({code:40001,message:'SCTprivatekey'}));
    })), error=>{
      assert.match(error.message,expected);
      assert.doesNotMatch(error.message,/SCTprivatekey|https:/);
      return true;
    });
    assert.equal(calls,1);
    assert.equal(saves,2);
    assert.equal(state.handled[item.fingerprint],'delivery_uncertain');
  }
});

test('ServerChan success is saved and deduplicated', async () => {
  const state = {budget:{used:0},handled:{},seen:{}};
  const item = {fingerprint:'post-hash',identity:'post:confirm'};
  await deliver(state,[item],async()=>{},()=>sendServerChan('SCTplaceholder','title','body',async()=>new Response('{"code":0}')));
  assert.equal(state.handled[item.fingerprint],'sent');
  assert.equal(state.seen[item.identity],item.fingerprint);
});

test('unaccepted source status is observable without logging arbitrary response text', () => {
  const now = new Date().toISOString();
  const data = {schemaVersion:1,checkedAt:now,events:[],activities:[],monitor:{lastCollectedAt:now}};
  for (const [value, expected] of [['degraded','degraded'],['unknown','unknown'],[null,'missing'],['https://private.invalid/?key=secret','invalid']]) {
    assert.throws(()=>validate({...data,monitor:{...data.monitor,status:value}}), error=>{
      assert.match(error.message,new RegExp(`status=${expected}`));
      assert.doesNotMatch(error.message,/private.invalid|key=secret/);
      return true;
    });
  }
});
