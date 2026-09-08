export class AuthzError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** `InMemoryAuthzClient` was selected while `NODE_ENV=production`. */
export class InMemoryInProductionError extends AuthzError {
  constructor() {
    super(
      'refusing to use InMemoryAuthzClient under NODE_ENV=production — set SPICEDB_ENDPOINT and SPICEDB_TOKEN',
    );
  }
}
