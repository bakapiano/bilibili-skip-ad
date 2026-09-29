import { runChecks } from "/fetch-binding-checks.js";
postMessage(await runChecks("WorkerGlobalScope"));
