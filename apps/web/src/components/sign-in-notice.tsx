import { loginUrl } from '../lib/api';

/** Shared "not signed in" fallback — the API owns the WorkOS login flow. */
export function SignInNotice() {
  return (
    <p className="empty-state">
      You are not signed in. <a href={loginUrl()}>Sign in</a>.
    </p>
  );
}
