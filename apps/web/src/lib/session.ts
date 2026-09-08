import { cookies } from 'next/headers';

/** Name of the session cookie `@fde/api` sets on `/auth/callback`. */
export const SESSION_COOKIE = 'fde_session';

/**
 * The caller's `@fde/api` session token. Read from the `fde_session` cookie
 * (the web app is served same-site with the API), falling back to
 * `DEV_SESSION_TOKEN` for local development where the two run on different
 * ports — set it to a token minted by hitting the API's `/auth` flow directly.
 * `undefined` ⇒ not signed in; pages render a "Sign in" link.
 *
 * The `DEV_SESSION_TOKEN` fallback is only honoured when `NODE_ENV` is
 * explicitly `development` or `test` — an unset or `production` `NODE_ENV`
 * disables it, so a stray env var can never become a way to authenticate every
 * cookie-less request as one fixed user.
 */
const DEV_ENVS = new Set(['development', 'test']);

export async function getSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  const cookieToken = jar.get(SESSION_COOKIE)?.value;
  if (cookieToken) return cookieToken;
  if (DEV_ENVS.has(process.env.NODE_ENV ?? '') && process.env.DEV_SESSION_TOKEN) {
    return process.env.DEV_SESSION_TOKEN;
  }
  return undefined;
}
