import { readConfig } from "./config.js";
import { CacheStore } from "./store.js";
import { createCacheServer } from "./app.js";

const config = readConfig();
process.umask(0o077);
const store = new CacheStore(config.dbPath);
const [command = "serve", id] = process.argv.slice(2);

if (command === "serve") {
  store.prune(Date.now());
  const server = createCacheServer({
    ...config,
    store,
    onError: (code) => console.error(`Server error: ${code}`),
  });
  const cleanup = setInterval(() => store.prune(Date.now()), 600000);
  cleanup.unref();
  server.listen(config.port, config.host, () => {
    console.log(`BiliSkip shared cache listening on http://${config.host}:${config.port}`);
    console.log(
      "Submission limit: one request per IP per 1000ms; IP counts retained for seven UTC dates.",
    );
  });
  let closing = false;
  const shutdown = () => {
    if (closing) {
      return;
    }
    closing = true;
    clearInterval(cleanup);
    server.close(() => store.close());
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 10000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.once("error", (error) => {
    console.error(`Server failed to start: ${error.code || "INTERNAL"}`);
    clearInterval(cleanup);
    store.close();
    process.exitCode = 1;
  });
} else {
  try {
    if (command === "stats") {
      console.table(store.stats());
    } else if (command === "recent") {
      console.log(JSON.stringify(store.recent(), null, 2));
    } else if (command === "transcripts") {
      console.log(JSON.stringify(store.transcriptStats(), null, 2));
    } else if (command === "revoke" && /^[a-f0-9-]{36}$/.test(id || "")) {
      console.log(JSON.stringify({ revoked: store.revoke(id) }));
    } else {
      console.error(
        "Usage: node server/index.js [serve|stats|recent|transcripts|revoke <submission-id>]",
      );
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}
