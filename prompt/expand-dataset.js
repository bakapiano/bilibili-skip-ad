import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { boundedBody } from "../extension/lib/bilibili.js";
import { normalize } from "../extension/lib/core.js";
import { LabData, DEFAULT_DATA, digest, readJson, saveJson, packageDataset } from "./data.js";
import { caseId } from "./prepare.js";
import { ExclusionStore, exclusionFor, inTestSet } from "./datasets.js";
import { parseBucket, chooseSamples, randomPrefixes, collectSubtitles } from "./collect-batch.js";
import { parseCommunity } from "./community.js";

const ORIGIN = "http://127.0.0.1:43820";
const ROOT = path.join(DEFAULT_DATA, "expansions");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TARGET = 3000;
const MARKER = path.join(ROOT, "community-3000-2026-10-02.json");

export function assertExpansionResumable(marker) {
  assert.ok(
    !marker || ["collecting", "paused"].includes(marker.status),
    "This collection is closed; inspect its replacement cohort before starting a new plan",
  );
}

export async function buildExpandedSample(record, context, batchId, createdAt) {
  assert.equal(record.transcript?.status, "ready");
  assert.match(record.source?.prefix, /^[a-f0-9]{4}$/);
  const verified = await normalize(context.video, context.cues, context.source);
  assert.equal(verified.transcript_sha256, context.transcript_sha256);
  assert.equal(verified.video_key, context.video_key);
  assert.equal(record.bvid, verified.video.bvid);
  assert.equal(record.cid, verified.video.cid);
  assert.equal(record.transcript.sha256, verified.transcript_sha256);
  const segments = parseCommunity(record.community.raw, verified.video);
  assert.ok(
    segments.some(
      (segment) =>
        segment.comparable && segment.category === "sponsor" && segment.actionType === "skip",
    ),
  );
  const sample = {
    schemaVersion: 2,
    id: caseId(verified),
    video: verified.video,
    createdAt,
    source: {
      kind: "curated-input",
      origins: [
        { kind: "community-expansion", batchId, prefix: record.source.prefix, bvid: record.bvid },
      ],
    },
    datasets: ["community-expanded"],
    split:
      parseInt(digest(verified.video.bvid).slice(0, 8), 16) % 5 === 0 ? "holdout" : "development",
    baseline: null,
    baselineHistory: [],
    transcript: { status: "ready", context: verified, matchesBaseline: null },
    community: {
      status: "ok",
      segments,
      fetchedAt: record.fetchedAt,
      source: "community random hash bucket; unreviewed reference",
    },
    review: null,
  };
  assert.ok(
    !/\bsk-[A-Za-z0-9_-]{24,}\b|SESSDATA\s*[:=]|bili_jct\s*[:=]/.test(JSON.stringify(sample)),
  );
  return sample;
}

async function ensureIdle(revision) {
  const response = await fetch(`${ORIGIN}/api/bootstrap`, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  assert.ok(response.ok);
  const boot = await response.json();
  assert.equal(boot.activeRun, null, "Finish the current model batch before changing dataset");
  assert.equal(
    (await new ExclusionStore(DEFAULT_DATA).read()).revision,
    revision,
    "Eligibility changed: inspect dataset before resuming",
  );
}

export async function expandDataset() {
  const db = new LabData();
  const original = await db.list();
  const ledger = await new ExclusionStore(db.root).read();
  let marker = await readJson(MARKER, null);
  assertExpansionResumable(marker);
  let plan;
  if (!marker) {
    const active = original.filter(
      (sample) => inTestSet(sample, "community") && !exclusionFor(sample, ledger)?.excluded,
    );
    assert.equal(active.length, 567, "Inspect current dataset size before starting this expansion");
    const previous = await readJson(
      path.resolve(
        "data/prompt-lab/community-batches/f8412a90-b0db-4cba-9d23-5646e8986230/collection.json",
      ),
    );
    const usedPrefixes = new Set(previous.buckets.map((bucket) => bucket.prefix));
    plan = {
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      targetEffective: TARGET,
      initialIds: active.map((sample) => sample.id),
      initialUniqueVideos: new Set(active.map((sample) => sample.video.bvid)).size,
      initialAllBvids: [...new Set(original.map((sample) => sample.video.bvid))],
      datasetRevision: ledger.revision,
      seed: randomBytes(16).toString("hex"),
      prefixes: randomPrefixes(65536)
        .filter((prefix) => !usedPrefixes.has(prefix))
        .slice(0, 6000),
      excludedOldPrefixCount: usedPrefixes.size,
      communityGapMs: 500,
      subtitleConcurrency: 8,
      candidateLimitPerRound: 180,
    };
    marker = {
      id: plan.id,
      status: "collecting",
      createdAt: plan.createdAt,
      targetEffective: TARGET,
    };
    await saveJson(path.join(ROOT, plan.id, "plan.json"), plan);
    await saveJson(MARKER, marker);
  } else {
    plan = await readJson(path.join(ROOT, marker.id, "plan.json"));
  }
  await ensureIdle(plan.datasetRevision);
  const root = path.join(ROOT, plan.id);
  const state = await readJson(path.join(root, "state.json"), {
    prefixCursor: 0,
    rounds: [],
    importedIds: [],
    paused: null,
  });
  if (state.paused) {
    assert.ok(
      Date.now() >= (state.paused.resumeAfter || 0),
      "Honor server retry-after before resuming",
    );
    state.paused = null;
  }
  marker.status = "collecting";
  delete marker.paused;
  await saveJson(MARKER, marker);
  const known = new Set(plan.initialAllBvids);
  for (const round of state.rounds) {
    for (const candidate of round.candidates) {
      known.add(candidate.bvid);
    }
  }
  const progress = async (phase, extra = {}) => {
    const value = {
      phase,
      id: plan.id,
      target: TARGET,
      effective: plan.initialIds.length + state.importedIds.length,
      added: state.importedIds.length,
      buckets: state.prefixCursor,
      rounds: state.rounds.length,
      ...extra,
    };
    console.log(JSON.stringify(value));
    await saveJson(path.join(root, "progress.json"), value);
  };
  const pause = async (reason) => {
    state.paused = reason;
    state.pauseHistory ||= [];
    state.pauseHistory.push(reason);
    if (reason.site === "bilibili") {
      state.subtitleTransport = {
        concurrency: 4,
        requestGapMs: Math.min(
          1000,
          Math.max(60, (state.subtitleTransport?.requestGapMs || 0) * 2),
        ),
      };
    }
    marker.status = "paused";
    marker.paused = reason;
    await saveJson(path.join(root, "state.json"), state);
    await saveJson(MARKER, marker);
    await progress("paused", { reason });
  };
  let lastRequest = 0;
  while (plan.initialIds.length + state.importedIds.length < TARGET) {
    await ensureIdle(plan.datasetRevision);
    let round = state.rounds.find((item) => !item.importComplete);
    if (!round) {
      round = {
        index: state.rounds.length + 1,
        candidates: [],
        gathering: true,
        importComplete: false,
      };
      state.rounds.push(round);
    }
    while (
      round.gathering &&
      round.candidates.length < plan.candidateLimitPerRound &&
      state.prefixCursor < plan.prefixes.length
    ) {
      const prefix = plan.prefixes[state.prefixCursor];
      const file = path.join(root, "buckets", `${prefix}.json`);
      let bucket = await readJson(file, null);
      if (!bucket || !["ok", "empty"].includes(bucket.status)) {
        await wait(Math.max(0, plan.communityGapMs - (Date.now() - lastRequest)));
        lastRequest = Date.now();
        const url = `https://bsbsb.top/api/skipSegments/${prefix}?${new URLSearchParams({ categories: '["sponsor"]' })}`;
        bucket = { prefix, url, fetchedAt: new Date().toISOString() };
        try {
          const response = await fetch(url, {
            headers: { Origin: ORIGIN, "x-ext-version": "biliskip-prompt-lab/0.1" },
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          });
          bucket.httpStatus = response.status;
          if ([403, 412, 429].includes(response.status)) {
            const retry = response.headers.get("retry-after");
            const seconds = Number(retry);
            const retryTime =
              retry && Number.isFinite(seconds)
                ? Date.now() + seconds * 1000
                : retry
                  ? Date.parse(retry)
                  : NaN;
            bucket.status = "paused";
            bucket.retryAfter = retry;
            await response.body?.cancel();
            await saveJson(file, bucket);
            await pause({
              site: "community",
              httpStatus: response.status,
              retryAfter: retry,
              resumeAfter: Number.isFinite(retryTime)
                ? Math.max(Date.now() + 60000, retryTime)
                : Date.now() + 60000,
            });
            return marker;
          }
          if (response.status === 404) {
            await response.body?.cancel();
            bucket.status = "empty";
            bucket.raw = [];
            bucket.accepted = [];
          } else {
            assert.ok(response.ok, `Community HTTP ${response.status}`);
            bucket.raw = JSON.parse(
              new TextDecoder().decode(await boundedBody(response, 4 * 1024 * 1024)),
            );
            const parsed = parseBucket(bucket.raw, prefix);
            bucket.accepted = parsed.accepted;
            bucket.rejected = parsed.rejected;
            bucket.rawSha256 = digest(bucket.raw);
            bucket.status = "ok";
          }
        } catch (error) {
          bucket.status = "error";
          bucket.errorCode = error.code || error.name;
        }
        await saveJson(file, bucket);
      }
      for (const candidate of bucket.accepted || []) {
        if (known.has(candidate.bvid)) {
          continue;
        }
        known.add(candidate.bvid);
        round.candidates.push(...chooseSamples([candidate], plan.seed, 1));
      }
      state.prefixCursor++;
      await saveJson(path.join(root, "state.json"), state);
      if (state.prefixCursor % 20 === 0) {
        await progress("community", {
          round: round.index,
          roundCandidates: round.candidates.length,
        });
      }
    }
    round.gathering = false;
    assert.ok(round.candidates.length, "Random prefix budget exhausted before target");
    await saveJson(path.join(root, "state.json"), state);
    const roundRoot = path.join(root, `round-${String(round.index).padStart(3, "0")}`);
    const collection = { selectedCount: round.candidates.length, candidates: round.candidates };
    await saveJson(path.join(roundRoot, "collection.json"), collection);
    const transport =
      state.subtitleTransport ||
      (state.pauseHistory?.some((item) => item.site === "bilibili")
        ? { concurrency: 4, requestGapMs: 60 }
        : { concurrency: 8, requestGapMs: 0 });
    const pass = await collectSubtitles(roundRoot, { id: plan.id }, collection, transport);
    await ensureIdle(plan.datasetRevision);
    const current = await db.list();
    const currentIds = new Set(current.map((sample) => sample.id));
    const currentBvids = new Set(current.map((sample) => sample.video.bvid));
    round.failures = [];
    round.ready = 0;
    for (const candidate of round.candidates) {
      const record = await readJson(
        path.join(roundRoot, "samples", `${candidate.bvid}.json`),
        null,
      );
      if (record?.transcript.status !== "ready") {
        round.failures.push({
          bvid: candidate.bvid,
          status: record?.transcript.status || "pending",
          code: record?.transcript.errorCode,
        });
        continue;
      }
      round.ready++;
      if (plan.initialIds.length + state.importedIds.length >= TARGET) {
        continue;
      }
      try {
        assert.match(record.transcript.file, /^contexts\/BV[A-Za-z0-9]{10}-\d+\.json$/);
        const context = await readJson(path.join(roundRoot, record.transcript.file));
        const sample = await buildExpandedSample(
          record,
          context,
          plan.id,
          new Date().toISOString(),
        );
        if (state.importedIds.includes(sample.id)) {
          continue;
        }
        if (currentIds.has(sample.id)) {
          const saved = await db.get(sample.id);
          assert.ok(
            saved.source.origins.some((origin) => origin.batchId === plan.id),
            "Existing foreign sample is preserved",
          );
          state.importedIds.push(sample.id);
        } else {
          assert.ok(!currentBvids.has(sample.video.bvid), "Existing video is preserved");
          await db.save(sample);
          state.importedIds.push(sample.id);
          currentIds.add(sample.id);
          currentBvids.add(sample.video.bvid);
        }
        await saveJson(path.join(root, "state.json"), state);
      } catch (error) {
        round.failures.push({
          bvid: candidate.bvid,
          status: "import-rejected",
          code: error.code || error.name,
          message: String(error.message).slice(0, 300),
        });
      }
    }
    await db.manifest();
    if (pass.stopped) {
      const retry = pass.stopped.retryAfter;
      const seconds = Number(retry);
      const retryTime =
        retry && Number.isFinite(seconds)
          ? Date.now() + seconds * 1000
          : retry
            ? Date.parse(retry)
            : NaN;
      await pause({
        ...pass.stopped,
        resumeAfter: Number.isFinite(retryTime)
          ? Math.max(Date.now() + 60000, retryTime)
          : Date.now() + 60000,
      });
      return marker;
    }
    round.importComplete = true;
    await saveJson(path.join(root, "state.json"), state);
    await progress("round-complete", {
      round: round.index,
      candidates: round.candidates.length,
      ready: round.ready,
    });
  }
  const all = await db.list();
  const effective = all.filter(
    (sample) => inTestSet(sample, "community") && !exclusionFor(sample, ledger)?.excluded,
  );
  assert.equal(effective.length, TARGET);
  assert.equal(
    new Set(effective.map((sample) => sample.video.bvid)).size,
    plan.initialUniqueVideos + state.importedIds.length,
  );
  const ids = [...plan.initialIds, ...state.importedIds];
  assert.equal(ids.length, TARGET);
  const frozen = {
    createdAt: new Date().toISOString(),
    target: TARGET,
    ids,
    initialIds: plan.initialIds,
    addedIds: state.importedIds,
    datasetRevision: ledger.revision,
    datasetSha256: digest(
      effective
        .map(
          (sample) =>
            `${sample.transcript.context.video_key}:${sample.transcript.context.transcript_sha256}`,
        )
        .sort(),
    ),
    labelPolicy:
      "Community sponsor/skip unreviewed references; random prefix sampling conditional on subtitle availability. Prior 567 retained; added cohort independent of prompt outputs.",
  };
  await saveJson(path.join(root, "frozen-dataset.json"), frozen);
  marker.status = "complete";
  marker.finishedAt = new Date().toISOString();
  marker.effective = TARGET;
  marker.added = state.importedIds.length;
  marker.root = root;
  marker.export = await packageDataset(db);
  await saveJson(MARKER, marker);
  await progress("complete", { marker: MARKER });
  return marker;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await expandDataset()));
}
