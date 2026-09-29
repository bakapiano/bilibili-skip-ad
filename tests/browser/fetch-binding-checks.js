import { BilibiliClient } from "/extension/lib/bilibili.js";
import { DeepSeekClient, SharedClient } from "/extension/lib/providers.js";

export async function runChecks(realm) {
  const rows = [];
  const cases = [["原始未绑定调用", { fetcher: globalThis.fetch }, true],
    ["BilibiliClient", new BilibiliClient(), false],
    ["DeepSeekClient", new DeepSeekClient(), false],
    ["SharedClient", new SharedClient(), false]];
  for (const [name, client, baseline] of cases) {
    try {
      const response = await client.fetcher("/probe", { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(3000) });
      const body = await response.json();
      rows.push({ realm, name, pass: !baseline && response.ok && body.ok, result: `HTTP ${response.status}` });
    } catch (error) {
      const result = `${error.name}: ${error.message}`;
      rows.push({ realm, name, pass: baseline && error.name === "TypeError" && /Illegal invocation/i.test(error.message), result });
    }
  }
  return rows;
}
