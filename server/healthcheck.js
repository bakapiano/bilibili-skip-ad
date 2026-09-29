try {
  const response = await fetch("http://127.0.0.1:8787/healthz", {
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  process.exitCode = response.ok && body.ok === true ? 0 : 1;
} catch {
  process.exitCode = 1;
}
