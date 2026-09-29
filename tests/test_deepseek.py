import copy
import io
import json
import tempfile
import unittest
import urllib.error
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import deepseek_backend as ds
import poc
from test_poc import fixture, labels


PRICING = json.loads((poc.ROOT / "deepseek-pricing.json").read_text(encoding="utf-8"))


def response_payload():
    transcript = fixture()
    return {"id": "fake-response-id", "model": "deepseek-flash",
            "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(labels(transcript)),
                                                                   "reasoning_content": "private reasoning is discarded"}}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 500, "total_tokens": 1500,
                      "prompt_cache_hit_tokens": 100, "prompt_cache_miss_tokens": 900,
                      "prompt_tokens_details": {"cached_tokens": 100},
                      "completion_tokens_details": {"reasoning_tokens": 100}}}


class StubOpener:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return io.BytesIO(json.dumps(self.payload).encode("utf-8"))


def request():
    return ds.build_request(fixture(), (poc.ROOT / "prompt.md").read_text(encoding="utf-8"),
                            json.loads((poc.ROOT / "labels.schema.json").read_text(encoding="utf-8")))


class DeepSeekTests(unittest.TestCase):
    def test_exact_flash_model_and_json_mode(self):
        value = request()
        self.assertEqual(value["model"], "deepseek-flash")
        self.assertEqual(value["thinking"], {"type": "disabled"})
        self.assertEqual(value["response_format"], {"type": "json_object"})
        self.assertEqual(value["temperature"], 0)
        self.assertEqual(value["messages"][0]["role"], "system")
        self.assertEqual(json.loads(value["messages"][1]["content"])["cues"], fixture()["cues"])
        self.assertNotIn("api_key", value)
        self.assertNotIn("tools", value)

    def test_usage_and_reasoning_counted_once(self):
        usage = ds.normalized_usage(response_payload()["usage"])
        cost = ds.estimate_cost(usage, PRICING)
        self.assertEqual(cost["estimated_cny"], {"off_peak": "0.00290200", "peak": "0.00580400"})
        self.assertEqual(cost["all_input_uncached_cny"]["off_peak"], "0.00300000")
        self.assertEqual(cost["components_cny"]["off_peak"]["output"], "0.00200000")

    def test_nested_cached_tokens_fallback(self):
        raw = response_payload()["usage"]
        raw.pop("prompt_cache_hit_tokens")
        raw.pop("prompt_cache_miss_tokens")
        usage = ds.normalized_usage(raw)
        self.assertEqual(usage["prompt_cache_hit_tokens"], 100)
        self.assertEqual(usage["prompt_cache_miss_tokens"], 900)
        self.assertEqual(usage["cache_breakdown"], "api-measured")

    def test_missing_cache_breakdown_is_explicit_upper_bound(self):
        usage = ds.normalized_usage({"prompt_tokens": 1000, "completion_tokens": 100})
        self.assertEqual(usage["prompt_cache_miss_tokens"], 1000)
        self.assertEqual(usage["cache_breakdown"], "assumed-all-miss-upper-bound")

    def test_inconsistent_usage_fails_closed(self):
        for mutation in ({"prompt_cache_hit_tokens": 2000}, {"prompt_tokens": True},
                         {"completion_tokens": -1}, {"total_tokens": 999},
                         {"prompt_tokens_details": {"cached_tokens": 999}},
                         {"completion_tokens_details": {"reasoning_tokens": 999}}):
            raw = response_payload()["usage"]
            raw.update(mutation)
            with self.assertRaises(ds.DeepSeekError):
                ds.normalized_usage(raw)

    def test_tariff_time_hint_handles_uncertain_holidays(self):
        self.assertEqual(ds.period_hint(datetime(2026, 9, 28, 22, 0, tzinfo=ds.BEIJING)), "off_peak")
        self.assertEqual(ds.period_hint(datetime(2026, 9, 28, 9, 0, tzinfo=ds.BEIJING)), "peak-if-not-statutory-holiday")
        self.assertEqual(ds.period_hint(datetime(2026, 9, 28, 12, 0, tzinfo=ds.BEIJING)), "off_peak")
        self.assertEqual(ds.period_hint(datetime(2026, 9, 27, 10, 0, tzinfo=ds.BEIJING)), "off_peak")

    def test_invalid_model_limit_and_rates(self):
        with self.assertRaises(ds.DeepSeekError):
            ds.build_request(fixture(), "", {}, model="another-model")
        with self.assertRaises(ds.DeepSeekError):
            ds.build_request(fixture(), "", {}, max_tokens=0)
        for value in ("NaN", "-1", "not-a-number"):
            rates = copy.deepcopy(PRICING)
            rates["off_peak"]["output"] = value
            with self.assertRaises(ds.DeepSeekError):
                ds.estimate_cost(ds.normalized_usage(response_payload()["usage"]), rates)

    def test_direct_request_and_safe_metadata(self):
        opener = StubOpener(response_payload())
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "sk-test-only"}), \
                patch("deepseek_backend.urllib.request.build_opener", return_value=opener):
            content, metadata = ds.call_deepseek(request(), PRICING)
        self.assertEqual(json.loads(content)["segments"][0]["start_id"], 2)
        sent, _ = opener.requests[0]
        self.assertEqual(sent.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(sent.get_header("Authorization"), "Bearer sk-test-only")
        self.assertEqual(len(opener.requests), 1)
        self.assertNotIn("sk-test-only", json.dumps(metadata))
        self.assertNotIn("private reasoning", json.dumps(metadata))

    def test_missing_key_prevents_request(self):
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": ""}), \
                patch("deepseek_backend.urllib.request.build_opener") as opener:
            with self.assertRaises(ds.DeepSeekError):
                ds.call_deepseek(request(), PRICING)
        opener.assert_not_called()

    def test_error_body_and_credentials_are_not_echoed(self):
        failure = urllib.error.HTTPError(ds.ENDPOINT, 401, "secret sk-test-only", {}, io.BytesIO(b"secret sk-test-only"))
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "sk-test-only"}), \
                patch("deepseek_backend.urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = failure
            with self.assertRaises(ds.DeepSeekError) as result:
                ds.call_deepseek(request(), PRICING)
        self.assertIn("401", str(result.exception))
        self.assertNotIn("sk-test-only", str(result.exception))
        self.assertEqual(factory.return_value.open.call_count, 1)

    def test_redirects_are_rejected(self):
        self.assertIsNone(ds.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test"))

    def test_truncated_output_preserves_chargeable_usage(self):
        raw = response_payload()
        raw["choices"][0]["finish_reason"] = "length"
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "sk-test-only"}), \
                patch("deepseek_backend.urllib.request.build_opener", return_value=StubOpener(raw)):
            with self.assertRaises(ds.DeepSeekError) as error:
                ds.call_deepseek(request(), PRICING)
        self.assertEqual(error.exception.metadata["cost"]["estimated_cny"]["off_peak"], "0.00290200")

    def test_deepseek_cli_retains_codex_baseline_and_exports_usage(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict("os.environ", {"DEEPSEEK_API_KEY": "sk-test-only"}), \
                patch("deepseek_backend.urllib.request.build_opener", return_value=StubOpener(response_payload())), \
                patch("poc.call_codex") as codex:
            source = Path(folder) / "transcript.json"
            output = Path(folder) / "flash"
            poc.write_json(source, fixture())
            code = poc.main(["detect", str(source), "--provider", "deepseek", "--out-dir", str(output)])
            self.assertEqual(code, 0)
            codex.assert_not_called()
            self.assertTrue((output / "api-usage.json").is_file())
            self.assertNotIn("sk-test-only", (output / "api-request.json").read_text(encoding="utf-8"))
            self.assertEqual(poc.read_json(output / "segments.json")["detector"]["backend"], "deepseek-api")

    def test_invalid_label_json_still_writes_usage(self):
        raw = response_payload()
        raw["choices"][0]["message"]["content"] = "invalid JSON"
        with tempfile.TemporaryDirectory() as folder, patch.dict("os.environ", {"DEEPSEEK_API_KEY": "sk-test-only"}), \
                patch("deepseek_backend.urllib.request.build_opener", return_value=StubOpener(raw)):
            source = Path(folder) / "transcript.json"
            output = Path(folder) / "flash"
            poc.write_json(source, fixture())
            self.assertEqual(poc.main(["detect", str(source), "--provider", "deepseek", "--out-dir", str(output)]), 1)
            self.assertTrue((output / "api-usage.json").is_file())
            self.assertFalse((output / "segments.json").exists())


if __name__ == "__main__":
    unittest.main()
