import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  appName: process.env.APP_NAME || 'Recast',
  host: process.env.HOST || '127.0.0.1',
  port: num(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  // Uploaded and converted files are removed after this many minutes.
  retentionMinutes: num(process.env.RETENTION_MINUTES, 120),
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 4096) * 1024 * 1024,
  concurrency: num(process.env.CONCURRENCY, Math.max(2, Math.min(4, Math.floor(os.cpus().length / 3)))),
  jobTimeoutMs: num(process.env.JOB_TIMEOUT_MIN, 120) * 60 * 1000,
};

export const dirs = {
  uploads: path.join(config.dataDir, 'uploads'),
  jobs: path.join(config.dataDir, 'jobs'),
  profiles: path.join(config.dataDir, 'profiles'),
};
