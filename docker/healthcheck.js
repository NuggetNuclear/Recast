// Container health probe: succeeds when /api/health answers 200, sending Basic Auth when it is configured.
const { PORT = '3000', RECAST_AUTH_USER: user = '', RECAST_AUTH_PASSWORD: password = '' } = process.env;
const headers = user && password ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {};
fetch(`http://127.0.0.1:${PORT}/api/health`, { headers, signal: AbortSignal.timeout(4000) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
