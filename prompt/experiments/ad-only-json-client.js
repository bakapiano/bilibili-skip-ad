import assert from "node:assert/strict";
import { MODEL, MAX_BYTES } from "../../extension/lib/constants.js";
import { usageCost } from "../../extension/lib/core.js";
import { boundedBody } from "../../extension/lib/bilibili.js";
import { deepseekRequest } from "../../extension/lib/providers.js";
import { parsePartitionOutput } from "./partition-output.js";

// Local evaluation only. Runtime extension/userscript clients keep their current wire protocol.
export class AdOnlyJsonClient {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher.bind(globalThis);
  }

  async analyze(context, key) {
    assert.ok(typeof key === "string" && key.length >= 12 && !/\s/.test(key));
    const requestContext = structuredClone(context);
    const start = performance.now();
    let usage;
    try {
      const request = {
        ...deepseekRequest(requestContext),
        max_tokens: 8192,
        response_format: { type: "json_object" },
      };
      const response = await this.fetcher("https://api.deepseek.com/chat/completions", {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(45000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      assert.ok(response.ok, `Model HTTP ${response.status}`);
      const payload = JSON.parse(new TextDecoder().decode(await boundedBody(response, MAX_BYTES)));
      usage = usageCost(payload.usage);
      assert.ok(Array.isArray(payload.choices) && payload.choices.length === 1);
      const choice = payload.choices[0];
      assert.ok(choice.finish_reason === "stop" && !choice.message?.tool_calls?.length);
      return {
        ...parsePartitionOutput(requestContext, choice.message?.content, { adOnly: true }),
        usage,
        elapsedMs: Math.round(performance.now() - start),
        model: MODEL,
      };
    } catch (error) {
      error.details = { usage, elapsedMs: Math.round(performance.now() - start) };
      throw error;
    }
  }
}
