import { normalize } from "../../extension/lib/core.js";
import { DEFAULT_SETTINGS } from "../../extension/lib/constants.js";
import { LocalDB } from "../../extension/lib/db.js";
import { IDBFactory } from "fake-indexeddb";

export const ref = { bvid: "BV1pFUDBKE8X", page: 1 };
export const defaults = {
  ...DEFAULT_SETTINGS,
  consent: true,
  sharedRead: false,
  sharedUpload: false,
  autoUpload: false,
  apiKey: "test-only-placeholder",
};
export const video = { ...ref, cid: 34253507696, duration: 100, title: "合成测试视频", part: "P1" };
export const body = [
  { from: 0, to: 10, content: "正文开头" },
  { from: 10, to: 15, content: "感谢测试品牌赞助，欢迎购买" },
  { from: 15, to: 20, content: "点击链接领取测试优惠" },
  { from: 20, to: 30, content: "说回正题" },
];
export const context = () => normalize(video, body);
export const labels = (ctx) => ({
  video_key: ctx.video_key,
  transcript_sha256: ctx.transcript_sha256,
  summary: "一段合成赞助口播",
  segments: [
    {
      start_id: 2,
      end_id: 3,
      brand: "测试品牌",
      confidence: 0.98,
      reason: "赞助声明、优惠与购买引导",
      evidence_ids: [2, 3],
    },
  ],
});
export const usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_cache_hit_tokens: 100,
  prompt_cache_miss_tokens: 900,
};
export const database = () => new LocalDB(new IDBFactory(), `test-${crypto.randomUUID()}`);
export const json = (data, init) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" }, ...init });
export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const flush = () => new Promise((resolve) => setImmediate(resolve));
