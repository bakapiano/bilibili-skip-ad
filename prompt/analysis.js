import { LabData, sampleSummary, intervalDiff, communityReference, saveJson } from "./data.js";
import path from "node:path";
import { writeFile } from "node:fs/promises";

export async function auditDataset(db = new LabData()) {
  const samples = await db.list();
  const rows = samples.map(sampleSummary);
  const groups = (key) =>
    Object.fromEntries(
      Object.entries(Object.groupBy(rows, (row) => row[key])).map(([name, items]) => [
        name,
        items.length,
      ]),
    );
  const suspicious = [];
  for (const sample of samples) {
    const info = sampleSummary(sample);
    const flags = [];
    if (info.protected) {
      flags.push("coverage-at-least-50");
    }
    if (info.belowThreshold) {
      flags.push("below-default-0.90");
    }
    const reference = communityReference(sample);
    if (sample.baseline && reference?.length) {
      const diff = intervalDiff(sample.baseline.segments, reference);
      if (diff.onlyFirstSeconds > 10) {
        flags.push("model-extra-over-community");
      }
      if (diff.onlySecondSeconds > 10) {
        flags.push("community-extra-over-model");
      }
      if (diff.iou < 0.5) {
        flags.push("low-overlap-with-community");
      }
      for (const s of sample.baseline.segments) {
        const covered = reference
          .filter((r) => r.end > s.start && r.start < s.end)
          .sort((a, b) => a.start - b.start);
        if (covered.some((r, i) => i > 0 && r.start - covered[i - 1].end > 5)) {
          flags.push("bridges-community-gap");
          break;
        }
      }
    }
    if (
      sample.baseline?.segments.some(
        (s) =>
          /正文|非广告|不是广告|无广告|无商业|不属于|未发现|未见明显/.test(s.reason) &&
          s.confidence < 0.8,
      )
    ) {
      flags.push("reason-says-body-but-output-is-ad");
    }
    if (flags.length) {
      suspicious.push({ ...info, flags: [...new Set(flags)] });
    }
  }
  const totalSegments = samples.reduce((sum, s) => sum + (s.baseline?.segments.length || 0), 0);
  const report = {
    createdAt: new Date().toISOString(),
    scope:
      "Active online records with nonempty model segments; selection-biased, no global precision/recall implied",
    counts: {
      records: rows.length,
      videos: new Set(rows.map((r) => r.video.bvid)).size,
      parts: new Set(rows.map((r) => `${r.video.bvid}:${r.video.cid}`)).size,
      segments: totalSegments,
      versions: groups("promptVersion"),
      transcripts: groups("transcriptStatus"),
      community: groups("communityStatus"),
      communitySponsorComparable: rows.filter((r) => r.referenceCount > 0).length,
      protected: rows.filter((r) => r.protected).length,
      withLowScores: rows.filter((r) => r.belowThreshold > 0).length,
      reviewed: rows.filter((r) => r.reviewed).length,
    },
    flags: Object.fromEntries(
      [...new Set(suspicious.flatMap((r) => r.flags))].map((flag) => [
        flag,
        suspicious.filter((r) => r.flags.includes(flag)).length,
      ]),
    ),
    suspicious: suspicious.sort(
      (a, b) => (b.comparison?.onlyFirstSeconds || 0) - (a.comparison?.onlyFirstSeconds || 0),
    ),
  };
  await saveJson(path.join(db.root, "audit.json"), report);
  const text = [
    "# 本地缓存数据集初筛",
    `生成时间：${report.createdAt}`,
    "",
    "本数据集是模型自动标记样本，社区标注作为对照；以下是检查线索，并非人工真值。",
    "",
    `记录 ${rows.length} 条；视频 ${report.counts.videos} 个；区间 ${totalSegments} 段。`,
    "",
    ...Object.entries(report.flags).map(([flag, n]) => `- ${flag}: ${n}`),
    "",
    "## 高优先级样本",
    "",
    ...report.suspicious
      .slice(0, 25)
      .map(
        (row) =>
          `- ${row.video.bvid} · ${row.promptVersion} · ${row.video.title}：${row.flags.join(" / ")}；字幕 ${row.transcriptStatus}`,
      ),
    "",
  ].join("\n");
  await writeFile(path.join(db.root, "audit.md"), text);
  return report;
}
