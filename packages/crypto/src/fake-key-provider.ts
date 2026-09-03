import { randomBytes } from 'node:crypto';

import type { EngagementKeyRef, GeneratedDek, KeyProvider } from './key-provider.js';

const MARKER = Buffer.from('FAKE-UNWRAPPED:');

/**
 * In-memory, dependency-free `KeyProvider` for unit tests (no AWS). `generateDek`
 * still returns fresh random key material like real KMS would; what is fake is
 * the wrap — NOT SECURE: the "wrapped" DEK is the DEK itself behind a marker
 * prefix, so anyone can unwrap it. Never wire this into a non-test environment.
 */
export class FakeKeyProvider implements KeyProvider {
  async generateDek(_ref: EngagementKeyRef): Promise<GeneratedDek> {
    const dek = new Uint8Array(randomBytes(32));
    return { dek, wrappedDek: new Uint8Array(Buffer.concat([MARKER, Buffer.from(dek)])) };
  }

  async unwrapDek(_ref: EngagementKeyRef, wrappedDek: Uint8Array): Promise<Uint8Array> {
    const buf = Buffer.from(wrappedDek);
    if (buf.length !== MARKER.length + 32 || !buf.subarray(0, MARKER.length).equals(MARKER)) {
      throw new Error('FakeKeyProvider: not a fake-wrapped DEK');
    }
    return new Uint8Array(buf.subarray(MARKER.length));
  }
}
