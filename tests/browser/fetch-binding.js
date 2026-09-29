import { runChecks } from "/fetch-binding-checks.js";
const rows = await runChecks("Window");
const worker = new Worker("/fetch-binding-worker.js", { type: "module" });
const workerRows = await new Promise(resolve => {
  const timer = setTimeout(() => resolve([{ realm: "WorkerGlobalScope", name: "Worker startup", pass: false, result: "Timeout" }]), 5000);
  worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
  worker.onerror = () => { clearTimeout(timer); resolve([{ realm: "WorkerGlobalScope", name: "Worker startup", pass: false, result: "Worker error" }]); };
});
worker.terminate(); rows.push(...workerRows);
for (const row of rows) {
  const line = document.createElement("p"); line.className = row.pass ? "pass" : "fail";
  line.textContent = `${row.pass ? "PASS" : "FAIL"} · ${row.realm} · ${row.name} · ${row.result}`;
  document.getElementById("results").append(line);
}
document.body.dataset.state = rows.every(row => row.pass) ? "passed" : "failed";
document.getElementById("report").textContent = JSON.stringify({ timestamp: new Date().toISOString(), state: document.body.dataset.state, rows }, null, 2);
