import copy
import io
import json
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

import local_backend as local
import local_model
import poc
from test_poc import fixture, labels


def request():
    return local.build_local_request(fixture(), (poc.ROOT / "prompt.md").read_text(encoding="utf-8"),
                                     poc.read_json(poc.ROOT / "labels.schema.json"))


def payload():
    return {"model": "qwen3-4b-local", "id": "local-test", "choices": [
        {"finish_reason": "stop", "message": {"content": json.dumps(labels(fixture())), "reasoning_content": "hidden"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
            "timings": {"cache_n": 0, "prompt_n": 100, "predicted_n": 50}}


class Opener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, req, timeout):
        self.requests.append(req)
        return io.BytesIO(json.dumps(self.response).encode())


class LocalTests(unittest.TestCase):
    def test_endpoint_is_loopback_only(self):
        for url in ("http://127.0.0.1:8766/v1", "http://localhost:8766/v1/", "http://[::1]:8766/v1"):
            self.assertTrue(local.endpoint(url).endswith("/v1/chat/completions"))
        for url in ("https://api.deepseek.com/v1", "http://192.168.1.1:8766/v1", "http://127.0.0.1.evil:8766/v1",
                    "http://user:pass@127.0.0.1:8766/v1", "http://127.0.0.1:8766/v1?target=other", "http://127.0.0.1/v1"):
            with self.assertRaises(local.LocalModelError):
                local.endpoint(url)

    def test_local_request_constrains_identity_and_preserves_transcript(self):
        result = request()
        self.assertEqual(result["model"], "qwen3-4b-local")
        self.assertEqual(result["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(result["reasoning_effort"], "none")
        self.assertFalse(result["cache_prompt"])
        self.assertEqual(json.loads(result["messages"][1]["content"])["cues"], fixture()["cues"])
        schema = result["response_format"]["schema"]
        self.assertEqual(schema["properties"]["transcript_sha256"]["const"], fixture()["transcript_sha256"])
        self.assertNotIn("api_key", result)
        self.assertNotIn("tools", result)

    def test_schema_is_not_mutated(self):
        schema = poc.read_json(poc.ROOT / "labels.schema.json")
        original = copy.deepcopy(schema)
        local.build_local_request(fixture(), "", schema)
        self.assertEqual(schema, original)

    def test_thinking_mode_is_explicit(self):
        with self.assertRaises(local.LocalModelError):
            local.build_local_request(fixture(), "", {}, thinking="enabled")

    def test_local_auth_and_proxy_isolation(self):
        opener = Opener(payload())
        with patch.dict("os.environ", {"LOCAL_LLM_API_KEY": "local-test-key", "DEEPSEEK_API_KEY": "cloud-test-key"}), \
                patch("local_backend.urllib.request.build_opener", return_value=opener) as factory:
            content, metadata = local.call_local(request())
        req = opener.requests[0]
        self.assertEqual(req.get_header("Authorization"), "Bearer local-test-key")
        self.assertTrue(req.full_url.startswith("http://127.0.0.1:8766/"))
        self.assertEqual(factory.call_args.args[0].proxies, {})
        self.assertIsInstance(factory.call_args.args[1], local.NoRedirect)
        self.assertEqual(json.loads(content)["segments"][0]["start_id"], 2)
        self.assertEqual(metadata["cost"]["api_charge_cny"], "0")
        self.assertNotIn("local-test-key", json.dumps(metadata))
        self.assertNotIn("hidden", json.dumps(metadata))
        self.assertNotIn("cloud-test-key", req.data.decode())

    def test_remote_endpoint_fails_before_credentials_or_network(self):
        with patch("local_backend.local_key") as credentials, patch("local_backend.urllib.request.build_opener") as factory:
            with self.assertRaises(local.LocalModelError):
                local.call_local(request(), "https://example.com/v1")
        credentials.assert_not_called()
        factory.assert_not_called()

    def test_http_errors_are_single_attempt_and_redacted(self):
        with patch("local_backend.local_key", return_value="secret-local-key"), \
                patch("local_backend.urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = urllib.error.HTTPError(local.DEFAULT_BASE_URL, 401, "secret-local-key", {}, None)
            with self.assertRaises(local.LocalModelError) as error:
                local.call_local(request())
        self.assertNotIn("secret-local-key", str(error.exception))
        self.assertEqual(factory.return_value.open.call_count, 1)

    def test_invalid_usage_and_truncated_response(self):
        for variant in ("usage", "length"):
            result = payload()
            if variant == "usage":
                result["usage"]["total_tokens"] = 99
            else:
                result["choices"][0]["finish_reason"] = "length"
            with patch("local_backend.local_key", return_value="local-key"), \
                    patch("local_backend.urllib.request.build_opener", return_value=Opener(result)):
                with self.assertRaises(local.LocalModelError) as error:
                    local.call_local(request())
            self.assertEqual(error.exception.metadata["backend"], "local-llama")

    def test_local_cli_skips_cloud_and_codex_calls(self):
        with tempfile.TemporaryDirectory() as folder, patch("local_backend.local_key", return_value="local-key"), \
                patch("local_backend.urllib.request.build_opener", return_value=Opener(payload())), \
                patch("poc.call_deepseek") as cloud, patch("poc.call_codex") as codex:
            source, output = Path(folder) / "transcript.json", Path(folder) / "result"
            poc.write_json(source, fixture())
            self.assertEqual(poc.main(["detect", str(source), "--provider", "local", "--out-dir", str(output)]), 0)
            cloud.assert_not_called()
            codex.assert_not_called()
            self.assertTrue((output / "local-usage.json").is_file())
            self.assertEqual(poc.read_json(output / "segments.json")["detector"]["backend"], "local-llama")

    def test_runtime_path_and_zip_escape_guards(self):
        with self.assertRaises(ValueError):
            local_model.inside_root(local_model.ROOT.parent / "unrelated-file")
        with self.assertRaises(ValueError):
            local_model.inside_root(local_model.ROOT)
        with tempfile.TemporaryDirectory(dir=local_model.ROOT) as folder:
            archive = Path(folder) / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("../escaped.txt", "test")
            with patch("local_model.RUNTIME", Path(folder) / "runtime"):
                with self.assertRaises(ValueError):
                    local_model.extract_runtime(archive)
            self.assertFalse((Path(folder) / "escaped.txt").exists())

    def test_process_ownership_checks_path_creation_time_and_pid(self):
        identity = {"path": str(local_model.RUNTIME / "llama-server.exe"), "started": "start-time"}
        state = {"status": "running", "pid": 123, "identity": identity}
        with patch("local_model.process_identity", return_value=identity):
            self.assertTrue(local_model.owned_process(state))
        with patch("local_model.process_identity", return_value={**identity, "started": "different"}):
            self.assertFalse(local_model.owned_process(state))
        other = {"path": str(local_model.ROOT / "other.exe"), "started": "start-time"}
        with patch("local_model.process_identity", return_value=other):
            self.assertFalse(local_model.owned_process({**state, "identity": other}))


if __name__ == "__main__":
    unittest.main()
