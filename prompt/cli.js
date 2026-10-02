import { LabData, packageDataset } from "./data.js";
import { exportOnline } from "./export.js";
import {
  collectCommunity,
  scanContexts,
  fetchMissingSubtitles,
  importContextFile,
} from "./collect.js";
import { auditDataset } from "./analysis.js";

const [command, ...args] = process.argv.slice(2);
const db = new LabData(process.env.BILISKIP_LAB_DATA);
const progress = (row) => console.log(JSON.stringify(row));
try {
  if (command === "export") {
    progress(await exportOnline(db));
  } else if (command === "community") {
    const result = await collectCommunity(db, { refresh: args.includes("--refresh"), progress });
    progress({ cases: result.count });
  } else if (command === "scan") {
    const result = await scanContexts(db, args.length ? args : [".tmp", "dist", "data"], {
      progress,
    });
    progress({
      cases: result.count,
      exact: result.cases.filter((c) => c.transcriptStatus === "exact").length,
    });
  } else if (command === "import") {
    if (!args.length) {
      throw new Error("请提供字幕JSON文件。");
    }
    for (const file of args) {
      progress(await importContextFile(db, file));
    }
    await db.manifest();
  } else if (command === "subtitles") {
    const result = await fetchMissingSubtitles(db, { limit: Number(args[0] || 100), progress });
    progress({
      cases: result.count,
      exact: result.cases.filter((c) => c.transcriptStatus === "exact").length,
    });
  } else if (command === "audit") {
    const result = await auditDataset(db);
    progress({ counts: result.counts, flags: result.flags });
  } else if (command === "package") {
    progress(await packageDataset(db));
  } else {
    throw new Error(
      "Usage: node prompt/cli.js export|community [--refresh]|scan [folders]|import <context.json>|subtitles [limit]|audit|package",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
