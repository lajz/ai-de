import { describe, expect, it } from 'vitest';
import type { Request } from 'express';

import { safeDevLoginRedirect } from './auth.controller.js';

function makeReq(opts: { referer?: string; host?: string }): Request {
  return { headers: { referer: opts.referer, host: opts.host } } as unknown as Request;
}

describe('safeDevLoginRedirect', () => {
  it("redirects to the referer's full URL when its host is allowed", () => {
    const req = makeReq({ referer: 'http://localhost:3001/engagements/e1?x=1' });
    expect(safeDevLoginRedirect(req, new Set(['localhost:3001']))).toBe(
      'http://localhost:3001/engagements/e1?x=1',
    );
  });

  it('falls back to "/" when the referer host is not in the allowed set', () => {
    const req = makeReq({ referer: 'https://evil.example/steal-tokens' });
    expect(safeDevLoginRedirect(req, new Set(['localhost:3001']))).toBe('/');
  });

  it('falls back to "/" when there is no referer at all', () => {
    const req = makeReq({});
    expect(safeDevLoginRedirect(req, new Set(['localhost:3001']))).toBe('/');
  });

  it('falls back to "/" for an unparseable referer', () => {
    const req = makeReq({ referer: 'not a url' });
    expect(safeDevLoginRedirect(req, new Set(['localhost:3001']))).toBe('/');
  });

  /**
   * The exact bug this test guards against: `apps/web` and `apps/api` are
   * different origins even in the standard local `tilt up` stack (web on
   * :3001, api on :3000). A referer host matching the *API's own*
   * `req.headers.host` alone would never match here — `AuthController`
   * additionally allows `WEB_BASE_URL`'s host for exactly this reason. And
   * the result must be the referer's *absolute* URL: a bare path would
   * resolve against the API's own origin (:3000), 404ing on a route-less
   * root — the original bug report this whole fix is for.
   */
  it("allows a configured web-app host that differs from the API's own host, and returns an absolute URL", () => {
    const req = makeReq({
      referer: 'http://localhost:3001/engagements/e1',
      host: 'localhost:3000',
    });
    expect(safeDevLoginRedirect(req, new Set([req.headers.host!, 'localhost:3001']))).toBe(
      'http://localhost:3001/engagements/e1',
    );
  });
});
