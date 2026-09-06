export class CryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No `EngagementCipher` is in scope — a 🔒 column was touched outside `runWithCrypto`. */
export class MissingCryptoContextError extends CryptoError {
  constructor() {
    super('no EngagementCipher in scope — wrap the call in runWithCrypto() / withEngagement()');
  }
}

/**
 * A ciphertext decrypted, but its embedded encryption context does not match the
 * current engagement + column. Indicates a blob was moved between rows/columns.
 */
export class DecryptContextMismatchError extends CryptoError {
  constructor(
    readonly expected: Record<string, string>,
    readonly actual: Record<string, string | undefined>,
  ) {
    super('ciphertext encryption context does not match the current engagement/column');
  }
}

/** The engagement's data key no longer exists (crypto-shred / BYOK revoke). */
export class EngagementShreddedError extends CryptoError {
  constructor(readonly engagementId: string) {
    super(`engagement ${engagementId} is crypto-shredded; its data key no longer exists`);
  }
}
