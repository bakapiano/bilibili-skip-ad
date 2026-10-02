import { execFile } from "node:child_process";
import path from "node:path";
import { LabData, importSnapshot, saveJson } from "./data.js";

export async function exportOnline(db = new LabData(), target = "root@175.178.13.169") {
  if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/.test(target)) {
    throw new Error("SSH目标格式异常。");
  }
  const code = `import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/shared-cache.sqlite',{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN');
try {
 const total=db.prepare('SELECT COUNT(*) AS count FROM records').get().count;
 const records=db.prepare("SELECT id,created_at,active,request_hash,payload FROM records WHERE active=1 AND json_array_length(payload,'$.segments')>0 ORDER BY created_at DESC,id DESC").all().map(r=>({...r,payload:JSON.parse(r.payload)}));
 console.log(JSON.stringify({schemaVersion:1,capturedAt:new Date().toISOString(),readOnly:true,totalOnlineRecords:total,selection:'active=1 AND segments.length>0',records}));db.exec('ROLLBACK');
}finally{db.close();}`;
  const result = await new Promise((resolve, reject) => {
    const child = execFile(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=12",
        target,
        "docker compose -p biliskipad -f /srv/biliskipad/compose.yaml exec -T api node --input-type=module",
      ],
      { timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) =>
        error
          ? reject(new Error("SSH只读导出失败，请检查本机连接。", { cause: error }))
          : resolve(stdout),
    );
    child.stdin.end(code);
  });
  if (/\bsk-[A-Za-z0-9_-]{24,}\b|SESSDATA\s*[:=]/.test(result)) {
    throw new Error("导出字段出现凭据特征，请人工检查。");
  }
  const snapshot = JSON.parse(result);
  const name = `snapshot-${snapshot.capturedAt.replaceAll(":", "-")}.json`;
  await saveJson(path.join(db.root, "snapshots", name), snapshot);
  const outcome = await importSnapshot(db, snapshot);
  await saveJson(path.join(db.root, "snapshots", `${name}.import.json`), outcome);
  await db.manifest();
  return {
    snapshot: name,
    totalOnline: snapshot.totalOnlineRecords,
    marked: snapshot.records.length,
    accepted: outcome.accepted.length,
    rejected: outcome.rejected,
  };
}
