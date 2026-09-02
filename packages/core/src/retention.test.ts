import { describe, expect, it } from 'vitest';

import { effectiveRetention, FORCED_RETENTION_BY_CONNECTOR, storesRawBody } from './index.js';

describe('retention', () => {
  it('pins Slack to reference-only regardless of engagement policy', () => {
    expect(FORCED_RETENTION_BY_CONNECTOR.slack).toBe('reference-only');
    expect(effectiveRetention('slack', 'full-retention')).toBe('reference-only');
  });

  it('lets other connectors follow the engagement policy', () => {
    expect(effectiveRetention('granola', 'derived-ephemeral-raw')).toBe('derived-ephemeral-raw');
  });

  it('never stores a body under reference-only', () => {
    expect(storesRawBody('reference-only')).toBe(false);
    expect(storesRawBody('derived-ephemeral-raw')).toBe(true);
    expect(storesRawBody('full-retention')).toBe(true);
  });
});
