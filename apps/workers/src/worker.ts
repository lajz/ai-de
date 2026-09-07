import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FakeKeyProvider, KmsKeyProvider, type KeyProvider } from '@fde/crypto';
import { createDbClient } from '@fde/db';
import { Worker } from '@temporalio/worker';

import { createActivities } from './activities/index.js';
import { connectWorkerConnection, loadTemporalConnectionConfig } from './connection.js';
import { DEFAULT_TASK_QUEUE } from './task-queue.js';

// Temporal's workflow bundler (webpack + swc-loader, built into
// @temporalio/worker) transpiles TypeScript itself, so this points straight at
// the *source* tree — no dist build required for `workflowsPath` in either dev
// or prod. Resolved from the package root (one level up from wherever this
// file itself is running from — `src/` in dev via tsx, `dist/` after `tsc
// -b`), not from this file's own directory, since `dist/workflows/` holds only
// compiled `.js`, not the `.ts` the bundler needs.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowsPath = join(packageRoot, 'src/workflows/index.ts');

function loadKeyProvider(env: NodeJS.ProcessEnv): KeyProvider {
  // Local dev without AWS creds: FDE_FAKE_KMS=true swaps in the in-memory
  // FakeKeyProvider (see @fde/crypto) — never set this outside dev/test.
  if (env.FDE_FAKE_KMS === 'true') return new FakeKeyProvider();
  return new KmsKeyProvider(env.AWS_REGION ? { region: env.AWS_REGION } : {});
}

export async function runWorker(): Promise<void> {
  const connectionConfig = loadTemporalConnectionConfig();
  const connection = await connectWorkerConnection(connectionConfig);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run the worker');
  const dbHandle = createDbClient({ url: process.env.DATABASE_URL });
  const keyProvider = loadKeyProvider(process.env);
  const activities = createActivities({ db: dbHandle.db, keyProvider });

  const worker = await Worker.create({
    connection,
    namespace: connectionConfig.namespace,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
    workflowsPath,
    activities,
  });

  const shutdown = () => worker.shutdown();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await worker.run();
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await dbHandle.close();
    await connection.close();
  }
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runWorker().catch((err: unknown) => {
    // message + stack only — never the raw error object, which for a
    // connection failure can carry the resolved TemporalConnectionConfig
    // (address, namespace) in its properties.
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`worker exited with an error: ${message}`);
    process.exitCode = 1;
  });
}
