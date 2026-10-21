import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SOURCE = 'https://aihot.news/api/v1/codex-resets';
const STATE_BRANCH = 'notifier-state';
const STATE_PATH = '.notifier-state.json';
const DAY = 86400000;
const ACTIONS = { announce: '已宣布／预告', confirm: '来源称已完成', amend: '更正／进展', cancel: '取消', hint: '可能（未确认）' };
const hash = value => createHash('sha256').update(value).digest('hex');
const date = value => Number.isFinite(Date.parse(value));
const shanghaiDay = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const displayTime = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const sourceURL = (url, id) => url === `https://x.com/thsottiaux/status/${id}`;

export function validate(data, now = Date.now()) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.events) || !Array.isArray(data.activities)
      || !date(data.checkedAt) || data.monitor?.status !== 'healthy'
      || !date(data.monitor.lastCollectedAt)
      || now - Date.parse(data.monitor.lastCollectedAt) > 2 * 3600000
      || Date.parse(data.checkedAt) > now + 10 * 60000) throw new Error('Source unavailable, stale, or schema changed; checkpoint unchanged.');
  const ids = new Set();
  for (const p of data.activities) {
    if (!/^\d+$/.test(p.id) || ids.has(p.id) || !date(p.publishedAt)
        || !sourceURL(p.url, p.id) || !Array.isArray(p.eventIds)
        || typeof p.originalText !== 'string' || typeof p.text !== 'string') throw new Error('Invalid source post; checkpoint unchanged.');
    ids.add(p.id);
  }
  return data;
}

export function signals(data) {
  const events = new Map(data.events.map(e => [e.id, e]));
  return data.activities.flatMap(p => {
    let action = p.kind === 'event_update' && p.eventIds.some(id => events.has(id)) && ACTIONS[p.action] ? p.action : null;
    // Only explicit tentative statements in Tibo's own text; never classify quoted user wishes.
    if (!action && /\b(might|may|maybe|possibly|considering)\b[^.!?\n]{0,70}\b(reset|resets)\b/i.test(p.originalText)
        && !/\?|\b(people|asking|asked|wish|requests?)\b/i.test(p.originalText)) action = 'hint';
    if (!action) return [];
    const event = p.eventIds.map(id => events.get(id)).find(Boolean);
    const identity = `${p.id}:${action}`;
    return [{ ...p, action, event, identity, fingerprint: hash(`${identity}:${p.originalText}`) }];
  }).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
}

export function plan(data, previous, now = Date.now()) {
  validate(data, now);
  const items = signals(data);
  if (!previous) return { baseline: true, pending: [], state: {
    version: 1, startedAt: new Date(now).toISOString(),
    seen: Object.fromEntries(items.map(p => [p.identity, p.fingerprint])),
    handled: {}, budget: { day: shanghaiDay(now), used: 0 }
  } };
  if (previous.version !== 1 || !previous.seen || !previous.handled || !date(previous.startedAt)
      || !previous.budget || !Number.isInteger(previous.budget.used)) throw new Error('Invalid saved state; refusing to replay history.');
  const state = structuredClone(previous);
  if (state.budget.day !== shanghaiDay(now)) state.budget = { day: shanghaiDay(now), used: 0 };
  // Backfilled older posts do not become fresh alerts. Corrections to known posts remain eligible.
  const pending = items.filter(p => {
    if (state.handled[p.fingerprint] || state.seen[p.identity] === p.fingerprint) return false;
    const published = Date.parse(p.publishedAt);
    if (published > now + 10 * 60000) throw new Error('Future source date; refusing notification.');
    const knownPost = Object.keys(state.seen).some(key => key.startsWith(`${p.id}:`));
    if (!knownPost && published < Date.parse(state.startedAt) - 5 * 60000) {
      state.seen[p.identity] = p.fingerprint;
      return false;
    }
    return true;
  });
  return { baseline: false, pending, state };
}

export function message(items) {
  // One digest per run; each item carries its own publication timestamp and certainty.
  return items.map(p => {
    const e = p.event;
    const scope = e?.presentation?.scopeKnown ? e.presentation.audienceZh || e.presentation.scopeLabel : null;
    return `### ${ACTIONS[p.action]}\n\n${p.text.slice(0, 1600)}\n\n`
      + `发布：${displayTime(p.publishedAt)}（北京时间）\n\n`
      + `范围：${scope || '原始信息未明确，不能视为所有账户适用'}\n\n`
      + `预计时间：以本条原文时间表述为准；未提供时不推算。\n\n`
      + `[Tibo 原帖](${p.url})\n\n原文：${p.originalText.slice(0, 1800)}`;
  }).join('\n\n---\n\n') + '\n\n来源：AIHOT 第三方整理（https://aihot.news/codex-reset），程序未直接核验 X。预告不等于已经到账，具体额度请查看自己的账户。';
}

async function request(url, options = {}) {
  try { return await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000) }); }
  catch { throw new Error('Network request failed or timed out (URL and credentials omitted).'); }
}

export async function githubStore(statePath = STATE_PATH, allowMissingState = false) {
  if (![STATE_PATH, '.feishu-state.json'].includes(statePath)) throw new Error('Unsupported state path.');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !process.env.GITHUB_TOKEN) throw new Error('Run from GitHub Actions with its repository token.');
  const base = `https://api.github.com/repos/${repo}`;
  const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const api = async (path, method = 'GET', body) => {
    const r = await request(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.status === 404 && method === 'GET') return null;
    if (!r.ok) throw new Error(`GitHub state operation failed (HTTP ${r.status}); check Actions contents write permission.`);
    return r.json();
  };
  let sha;
  let branchExists = !!(await api(`/git/ref/heads/${STATE_BRANCH}`));
  let state = null;
  if (branchExists) {
    const file = await api(`/contents/${statePath}?ref=${STATE_BRANCH}`);
    if (!file && !allowMissingState) throw new Error('State branch exists but state file is missing. Restore it before resuming.');
    if (file) {
      sha = file.sha;
      state = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    }
  }
  return { state, async save(value) {
    if (!branchExists) {
      if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) throw new Error('Missing workflow commit.');
      await api('/git/refs', 'POST', { ref: `refs/heads/${STATE_BRANCH}`, sha: process.env.GITHUB_SHA });
      branchExists = true;
    }
    const result = await api(`/contents/${statePath}`, 'PUT', {
      message: 'Save notification checkpoint', branch: STATE_BRANCH,
      content: Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64'), ...(sha ? { sha } : {})
    });
    sha = result.content.sha;
  } };
}

export async function deliver(state, items, save, send, isTest = false) {
  // Reserve before sending: a runner crash or ambiguous HTTP outcome never causes an automatic duplicate.
  if (state.budget.used >= (isTest ? 5 : 4)) return false;
  state.budget.used++;
  for (const p of items) state.handled[p.fingerprint] = 'reserved';
  await save(state);
  try {
    await send();
    for (const p of items) { state.handled[p.fingerprint] = 'sent'; state.seen[p.identity] = p.fingerprint; }
    await save(state);
  } catch {
    for (const p of items) state.handled[p.fingerprint] = 'delivery_uncertain';
    await save(state);
    throw new Error('Push failed or delivery uncertain. Check ServerChan log; automatic resend is suppressed to avoid duplicates.');
  }
  return true;
}

export async function main() {
  const key = process.env.SERVERCHAN_SENDKEY?.trim();
  if (!/^SCT[A-Za-z0-9]+$/.test(key || '')) throw new Error('Set SERVERCHAN_SENDKEY to your ServerChan Turbo SCT key in repository Actions secrets.');
  const response = await request(SOURCE, { headers: { 'User-Agent': 'GPT-Reset-Notifier/1.0 (+https://github.com/JoyYoung15/GPT-Reset-Notifier)' } });
  if (!response.ok) throw new Error(`Source HTTP ${response.status}; no notification or checkpoint advance.`);
  const data = validate(await response.json());
  const storage = await githubStore();
  const { state, pending, baseline } = plan(data, storage.state);
  const send = async (title, desp) => {
    const r = await request(`https://sctapi.ftqq.com/${key}.send`, {
      method: 'POST', body: new URLSearchParams({ title, desp })
    });
    if (!r.ok) throw new Error('Push HTTP error.');
    const result = await r.json();
    if (result.code !== 0) throw new Error('Push API rejected request.');
  };
  if (baseline || JSON.stringify(state) !== JSON.stringify(storage.state)) await storage.save(state);
  if (process.env.SEND_TEST === 'true') {
    const ok = await deliver(state, [], storage.save, () => send('【测试】GPT 重置微信提醒已接通', '这是一条配置测试，不代表发生了重置。\n\nGitHub Actions 已读取消息接口；首次运行只建立历史基线，后续有新的预告、确认或更正时才推送。\n\n来源覆盖：AIHOT 整理的 Tibo 消息。'), true);
    if (!ok) throw new Error('Daily test allowance exhausted.');
    console.log('Test accepted by ServerChan. Confirm receipt on your phone.');
    return;
  }
  if (!pending.length) { console.log(baseline ? 'Baseline created. Historical posts not sent.' : 'No new qualifying signal.'); return; }
  const batch = pending.slice(0, 2);
  const ok = await deliver(state, batch, storage.save, () => send(`GPT/Codex 重置动态：${ACTIONS[batch.at(-1).action]}`, message(batch)));
  console.log(ok ? 'New signal accepted by ServerChan.' : 'Daily automatic cap reached; pending signals retained.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
