import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, signals, validate, deliver, message } from '../monitor.mjs';

const start = Date.parse('2026-10-21T03:00:00Z');
const post = (id = '123', action = 'announce', at = start) => ({
  id, action, kind: 'event_update', eventIds: ['event1'],
  publishedAt: new Date(at).toISOString(), originalText: 'A reset is coming today.',
  text: '今天将重置。', url: `https://x.com/thsottiaux/status/${id}`
});
const snapshot = (activities, at = start) => ({
  schemaVersion: 1, checkedAt: new Date(at).toISOString(),
  monitor: { status: 'healthy', lastCollectedAt: new Date(at).toISOString() },
  events: [{ id: 'event1', presentation: { scopeKnown: false } }], activities
});
const baseline = () => plan(snapshot([post()]), null, start).state;

test('first run baselines history without notifying', () => {
  const r = plan(snapshot([post()]), null, start);
  assert.equal(r.baseline, true);
  assert.equal(r.pending.length, 0);
});
test('same post is silent, new confirmation is detected', () => {
  const state = baseline();
  assert.equal(plan(snapshot([post()]), state, start).pending.length, 0);
  const r = plan(snapshot([post(), post('124', 'confirm', start + 60000)], start + 60000), state, start + 60000);
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].action, 'confirm');
});
test('historical backfill is suppressed', () => {
  const r = plan(snapshot([post('99', 'confirm', start - 86400000)]), baseline(), start);
  assert.equal(r.pending.length, 0);
});
test('known historical post can receive a material action correction', () => {
  const old = post('123', 'announce', start - 86400000);
  const state = plan(snapshot([old]), null, start).state;
  assert.equal(plan(snapshot([{ ...old, action: 'cancel' }]), state, start).pending[0].action, 'cancel');
});
test('translation edits do not notify; original correction does', () => {
  assert.equal(plan(snapshot([{ ...post(), text: '重置即将到来。' }]), baseline(), start).pending.length, 0);
  assert.equal(plan(snapshot([{ ...post(), originalText: 'Reset postponed until tomorrow.' }]), baseline(), start).pending.length, 1);
});
test('related posts and user wishes do not trigger, explicit own-text hint does', () => {
  const related = { ...post(), kind: 'related', action: null, eventIds: [] };
  assert.equal(signals(snapshot([{ ...related, originalText: 'People asking for resets on the street.' }])).length, 0);
  assert.equal(signals(snapshot([{ ...related, originalText: 'Maybe a reset tomorrow?' }])).length, 0);
  assert.equal(signals(snapshot([{ ...related, originalText: 'We might reset limits tomorrow.' }]))[0].action, 'hint');
});
test('stale data, invalid links, duplicate IDs and broken schema fail closed', () => {
  assert.throws(() => validate(snapshot([post()], start - 3 * 3600000), start));
  assert.throws(() => validate(snapshot([{ ...post(), url: 'https://evil.example/123' }]), start));
  assert.throws(() => validate(snapshot([post(), post()]), start));
  assert.throws(() => validate({ ...snapshot([]), schemaVersion: 2 }, start));
});
test('state must persist before a message can be sent', async () => {
  let sent = false;
  await assert.rejects(deliver(baseline(), [signals(snapshot([post('124')]))[0]], async () => { throw Error('save failed'); }, async () => { sent = true; }));
  assert.equal(sent, false);
});
test('successful delivery deduplicates and consumes one request', async () => {
  const state = baseline();
  const items = signals(snapshot([post('124')]));
  let saved = 0;
  await deliver(state, items, async () => { saved++; }, async () => {});
  assert.equal(saved, 2);
  assert.equal(state.budget.used, 1);
  assert.equal(plan(snapshot([post('124')]), state, start).pending.length, 0);
});
test('uncertain delivery is not automatically repeated', async () => {
  const state = baseline();
  const items = signals(snapshot([post('124')]));
  await assert.rejects(deliver(state, items, async () => {}, async () => { throw Error('timeout'); }));
  assert.equal(state.handled[items[0].fingerprint], 'delivery_uncertain');
  assert.equal(plan(snapshot([post('124')]), state, start).pending.length, 0);
});
test('four automatic requests daily; fifth request reserved for manual test', async () => {
  const state = baseline();
  state.budget.used = 4;
  assert.equal(await deliver(state, [], async () => {}, async () => {}), false);
  assert.equal(await deliver(state, [], async () => {}, async () => {}, true), true);
  assert.equal(await deliver(state, [], async () => {}, async () => {}, true), false);
});
test('daily budget follows Shanghai midnight', () => {
  const state = baseline();
  state.budget.used = 4;
  const now = Date.parse('2026-10-21T16:01:00Z');
  assert.equal(plan(snapshot([post()], now), state, now).state.budget.used, 0);
});
test('unknown scope stays unknown and predictions are not rendered as schedules', () => {
  const data = snapshot([post()]);
  data.events[0].estimate = { label: 'MODEL PREDICTION' };
  const text = message(signals(data));
  assert.match(text, /范围：原始信息未明确/);
  assert.doesNotMatch(text, /MODEL PREDICTION/);
  assert.match(text, /第三方整理/);
});
