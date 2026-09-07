export class AuditError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No approved, unexpired, unrevoked break-glass grant exists for this engagement. */
export class BreakGlassRequiredError extends AuditError {
  constructor(readonly engagementId: string) {
    super(`no active break-glass grant for engagement ${engagementId}`);
  }
}

/** A grant's approver must be a different person than its requester. */
export class SelfApprovalError extends AuditError {
  constructor(readonly actorId: string) {
    super(`break-glass grant requested by ${actorId} cannot also be approved by them`);
  }
}
