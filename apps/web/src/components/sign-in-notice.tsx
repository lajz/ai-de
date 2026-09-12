import { devLoginUrl, loginUrl } from '../lib/api';

/** Shared "not signed in" fallback — the API owns the WorkOS login flow. */
export function SignInNotice() {
  return (
    <>
      <p className="empty-state">
        You are not signed in. <a href={loginUrl()}>Sign in</a>.
      </p>
      {process.env.NODE_ENV === 'development' && (
        <p className="empty-state">
          No WorkOS account here — <a href={devLoginUrl()}>Dev sign in</a> mints a local
          session directly instead of the (unreachable) WorkOS redirect above.
        </p>
      )}
    </>
  );
}
