import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { configuration, payload, sendFeishu, channelSettings } from '../feishu.mjs';
import { plan, deliver, loadSource } from '../monitor.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config = { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-placeholder', secret: 'test-secret' };

test('personal Feishu has a separate checkpoint while company keeps its existing history', () => {
  assert.equal(channelSettings().statePath, '.feishu-state.json');
  assert.equal(channelSettings('company').statePath, '.feishu-state.json');
  assert.equal(channelSettings('personal').statePath, '.feishu-personal-state.json');
  assert.match(channelSettings('personal').testTitle, /个人飞书/);
  assert.throws(() => channelSettings('../company'), /Unsupported/);
});

test('both channels reuse one validated source request and reject stale shared snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reset-source-test-'));
  const path = join(dir, 'source.json');
  let calls = 0;
  const now = new Date().toISOString();
  const data = {schemaVersion:1,checkedAt:now,monitor:{status:'healthy',lastCollectedAt:now},events:[],activities:[]};
  const fetcher = async () => {calls++; return new Response(JSON.stringify(data));};
  try {
    assert.deepEqual(await loadSource(path, fetcher), data);
    assert.deepEqual(await loadSource(path, fetcher), data);
    assert.equal(calls, 1);
    await writeFile(path, JSON.stringify({...data,monitor:{status:'healthy',lastCollectedAt:'2020-01-01T00:00:00Z'}}));
    await assert.rejects(loadSource(path, fetcher), /Invalid shared source/);
    assert.equal(calls, 1);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('Feishu is optional; incomplete config and non-Feishu destinations fail closed', () => {
  assert.equal(configuration({}), null);
  for (const url of [undefined, 'http://open.feishu.cn/open-apis/bot/v2/hook/id', 'https://evil.example/id', config.url + '?key=x', 'https://open.feishu.cn.evil.example/id']) {
    assert.throws(() => configuration({FEISHU_WEBHOOK_URL:url, FEISHU_SIGNING_SECRET:config.secret}));
  }
  assert.throws(() => configuration({FEISHU_WEBHOOK_URL:config.url}));
});

test('Feishu signing uses epoch seconds and the official empty-message HMAC scheme', async () => {
  const result = payload(config.secret, '标题', '正文', 1599360473000);
  assert.equal(result.timestamp, '1599360473');
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode('1599360473\ntest-secret'), {name:'HMAC', hash:'SHA-256'}, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify('HMAC', key, Buffer.from(result.sign, 'base64'), new Uint8Array()), true);
});

test('untrusted source text cannot mention everyone; Unicode payload stays within API byte limit', () => {
  const result = payload(config.secret, 'GPT', '<at user_id="all">所有人</at>' + '中文😀'.repeat(9000));
  assert.doesNotMatch(result.content.text, /<at/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 20000);
  assert.match(result.content.text, /截断/);
});

test('HTTP success alone is not delivery success and errors do not expose secret or webhook', async () => {
  await assert.rejects(sendFeishu(config, 'title', 'body', async () => new Response(JSON.stringify({code:19021, msg:config.secret}))), /code 19021/);
  await assert.rejects(sendFeishu(config, 'title', 'body', async () => {throw new Error(config.url + config.secret);}), {message:'Feishu network failure; delivery uncertain.'});
  await assert.rejects(sendFeishu(config, 'title', 'body', async () => new Response('bad', {status:302})), /HTTP 302/);
  await sendFeishu(config, 'title', 'body', async (url, init) => {
    assert.equal(url, config.url); assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).msg_type, 'text');
    assert.ok(JSON.parse(init.body).sign);
    return new Response(JSON.stringify({code:0}));
  });
});

test('separate channel checkpoints prevent replay and isolate delivery uncertainty', async () => {
  const now = Date.now();
  const post = {id:'123', kind:'event_update', action:'announce', eventIds:['e'], url:'https://x.com/thsottiaux/status/123', publishedAt:new Date(now).toISOString(), originalText:'Reset tonight', text:'今晚重置'};
  const data = {schemaVersion:1, checkedAt:new Date(now).toISOString(), monitor:{status:'healthy',lastCollectedAt:new Date(now).toISOString()},events:[{id:'e'}],activities:[post]};
  const wechat = plan(data, null, now).state;
  const firstFeishu = plan(data, null, now);
  assert.equal(firstFeishu.pending.length, 0);
  const newPost = {...post, id:'124', url:'https://x.com/thsottiaux/status/124'};
  data.activities.push(newPost);
  const w = plan(data, wechat, now), f = plan(data, firstFeishu.state, now);
  const personal = plan(data, null, now);
  assert.equal(personal.pending.length, 0); // joining later must not replay company history
  const personalBefore = JSON.stringify(personal.state);
  await assert.rejects(deliver(f.state, f.pending, async()=>{}, async()=>{throw Error('timeout');}));
  assert.equal(plan(data, w.state, now).pending.length, 1);
  await deliver(w.state, w.pending, async()=>{}, async()=>{});
  assert.equal(plan(data, w.state, now).pending.length, 0);
  assert.equal(plan(data, f.state, now).pending.length, 0);
  assert.equal(JSON.stringify(personal.state), personalBefore);
});
