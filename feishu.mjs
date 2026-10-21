import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { plan, message, deliver, githubStore } from './monitor.mjs';

export function configuration(env) {
  const url = env.FEISHU_WEBHOOK_URL?.trim();
  const secret = env.FEISHU_SIGNING_SECRET?.trim();
  if (!url && !secret) return null;
  if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url || '') || !secret) {
    throw new Error('Set FEISHU_WEBHOOK_URL and FEISHU_SIGNING_SECRET in repository Actions secrets.');
  }
  return { url, secret };
}

export function payload(secret, title, text, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  // Official bot signing scheme: HMAC key is timestamp + newline + secret; empty message.
  const sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  // Plain text, with mention markup neutralized. Limit bytes below Feishu's 20 KB body limit.
  const clean = `${title}\n\n${text}`.replaceAll('<', '＜').replaceAll('>', '＞');
  let clipped = ''; let bytes = 0;
  for (const char of clean) { bytes += Buffer.byteLength(char); if (bytes > 15000) break; clipped += char; }
  if (clipped.length < clean.length) clipped += '\n（内容较长，部分截断，请查看原帖。）';
  return { timestamp, sign, msg_type: 'text', content: { text: clipped } };
}

export async function sendFeishu(config, title, text, fetcher = fetch, now = Date.now()) {
  let response;
  try {
    response = await fetcher(config.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(config.secret, title, text, now))
    });
  } catch { throw new Error('Feishu network failure; delivery uncertain.'); }
  if (!response.ok) throw new Error(`Feishu HTTP ${response.status}; delivery not confirmed.`);
  let result;
  try { result = await response.json(); } catch { throw new Error('Feishu invalid response; delivery uncertain.'); }
  if (result.code !== 0) throw new Error(`Feishu rejected message (code ${Number.isInteger(result.code) ? result.code : 'unknown'}).`);
}

export async function main() {
  const config = configuration(process.env);
  if (!config) { console.log('Feishu not configured; skipped.'); return; }
  const response = await fetch('https://aihot.news/api/v1/codex-resets', {
    redirect: 'error', signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'GPT-Reset-Notifier/1.0' }
  }).catch(() => { throw new Error('Feishu source request failed.'); });
  if (!response.ok) throw new Error(`Feishu source HTTP ${response.status}.`);
  const data = await response.json();
  // Separate checkpoint: success/failure and test budgets never affect WeChat delivery.
  const storage = await githubStore('.feishu-state.json', true);
  const {state, pending, baseline} = plan(data, storage.state);
  if (baseline || JSON.stringify(state) !== JSON.stringify(storage.state)) await storage.save(state);
  const isTest = process.env.SEND_FEISHU_TEST === 'true';
  if (!isTest && !pending.length) {
    console.log(baseline ? 'Feishu baseline created. Historical posts not sent.' : 'Feishu: No new qualifying signal.'); return;
  }
  const batch = isTest ? [] : pending.slice(0, 2);
  let sendError;
  const ok = await deliver(state, batch, storage.save, async () => {
    try {
      await sendFeishu(config,
        isTest ? '【测试】GPT 重置飞书提醒已接通' : 'GPT/Codex 重置动态',
        isTest ? '这是一条配置测试，不代表发生重置。后续发现新的符合条件的 Tibo 消息时推送，无新消息保持安静。来源：AIHOT 第三方整理。' : message(batch));
    } catch (error) { sendError = error; throw error; }
  }, isTest).catch(() => { throw new Error(sendError?.message || 'Feishu state/delivery failed; inspect run before retrying.'); });
  if (!ok && isTest) throw new Error('Feishu daily test allowance exhausted.');
  console.log(ok ? (isTest ? 'Feishu test accepted by API.' : 'Feishu new signal accepted by API.') : 'Feishu daily cap reached; pending retained.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
