import { networkCode } from './source-request.mjs';

export class ServerChanError extends Error {}

export async function sendServerChan(key, title, desp, fetcher = fetch) {
  let response, result;
  try {
    response = await fetcher(`https://sctapi.ftqq.com/${key}.send`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      body: new URLSearchParams({ title, desp })
    });
  } catch (error) {
    throw new ServerChanError(`ServerChan send network failure (${networkCode(error)}); delivery uncertain.`);
  }
  if (!response.ok) throw new ServerChanError(`ServerChan send HTTP ${response.status}; delivery not confirmed.`);
  try { result = await response.json(); }
  catch { throw new ServerChanError('ServerChan send invalid JSON response; delivery uncertain.'); }
  if (result?.code !== 0) {
    throw new ServerChanError(`ServerChan send rejected (code ${Number.isInteger(result?.code) ? result.code : 'unknown'}).`);
  }
}
