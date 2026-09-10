/** Raised by `@fde/identity` for bad inputs and illegal review-queue transitions. */
export class IdentityError extends Error {
  override name = 'IdentityError';
}
