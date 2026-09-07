import type { TenantId } from '@fde/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TASK_QUEUE, taskQueueFor } from './task-queue.js';

describe('taskQueueFor', () => {
  it('namespaces the queue name by tenant', () => {
    expect(taskQueueFor('acme' as TenantId)).toBe('fde-acme');
    expect(taskQueueFor('other-tenant' as TenantId)).toBe('fde-other-tenant');
  });

  it('is distinct from the default queue', () => {
    expect(taskQueueFor('acme' as TenantId)).not.toBe(DEFAULT_TASK_QUEUE);
  });
});
