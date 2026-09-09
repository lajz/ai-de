import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FakeKeyProvider, KmsKeyProvider, type KeyProvider } from '@fde/crypto';
import { createDbClient } from '@fde/db';
import {
  createEmbeddingClientFromEnv,
  createRouter,
  createTracerFromEnv,
  tracingUsageSink,
} from '@fde/llm';
import { Worker } from '@temporalio/worker';

import { createActivities } from './activities/index.js';
import { loadRecallClient } from './capture/index.js';
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

export function loadKeyProvider(env: NodeJS.ProcessEnv): KeyProvider {
  // Local dev without AWS creds: FDE_FAKE_KMS=true swaps in the in-memory
  // FakeKeyProvider (see @fde/crypto), which is not real encryption — never
  // set this outside dev/test. Refused outright when NODE_ENV=production, so
  // a stray FDE_FAKE_KMS=true in a prod env file can't silently turn every
  // engagement's crypto-shred guarantee into a no-op.
  if (env.FDE_FAKE_KMS === 'true') {
    if (env.NODE_ENV === 'production') {
      throw new Error('FDE_FAKE_KMS=true is not allowed when NODE_ENV=production');
    }
    return new FakeKeyProvider();
  }
  return new KmsKeyProvider(env.AWS_REGION ? { region: env.AWS_REGION } : {});
}

export async function runWorker(): Promise<void> {
  const connectionConfig = loadTemporalConnectionConfig();
  const connection = await connectWorkerConnection(connectionConfig);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run the worker');
  const dbHandle = createDbClient({ url: process.env.DATABASE_URL });
  const keyProvider = loadKeyProvider(process.env);
  const recallClient = loadRecallClient(process.env);
  // Redacted tracing (`docs/architecture.md`: "Langfuse — redacted traces only").
  // `NoopTracer` unless both LANGFUSE_* keys are set; the sink turns each
  // content-free `UsageRecord` into a redacted span, and `traceExtraction` inside
  // `runExtractionActivity` groups a run's per-chunk generations under one trace.
  const tracer = createTracerFromEnv(process.env);
  const router = createRouter({ onUsage: tracingUsageSink(tracer) });
  const embeddingClient = createEmbeddingClientFromEnv(process.env);
  const activities = createActivities({
    db: dbHandle.db,
    keyProvider,
    recallClient,
    router,
    embeddingClient,
    tracer,
  });

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
    await tracer.shutdown(); // flush queued redacted spans; never throws
    await dbHandle.close();
    await connection.close();
  }
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runWorker().catch((err: unknown) => {
    // message only — never the raw error object (or its stack, which can
    // quote the failing call's arguments) — a connection failure can carry
    // the resolved TemporalConnectionConfig (address, namespace) in either.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`worker exited with an error: ${message}`);
    process.exitCode = 1;
  });
}
