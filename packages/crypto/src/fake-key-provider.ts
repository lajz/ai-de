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

  /**
   * The fake wrap format doesn't depend on the key ref at all, so "re-wrapping
   * under a new key" is: unwrap (validates the old wrap, same as real KMS would
   * reject a wrong key) and re-wrap the same DEK bytes. `_newRef` is unused —
   * there's no real key to switch to — but kept in the signature so call sites
   * are identical to `KmsKeyProvider`.
   */
  async rewrapDek(
    oldRef: EngagementKeyRef,
    wrappedDek: Uint8Array,
    _newRef: EngagementKeyRef,
  ): Promise<Uint8Array> {
    const dek = await this.unwrapDek(oldRef, wrappedDek);
    return new Uint8Array(Buffer.concat([MARKER, Buffer.from(dek)]));
  }
}
