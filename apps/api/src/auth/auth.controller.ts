import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import type { Env } from '../config/env.js';
import { Public } from '../request-context/metadata.js';
import { AuthService } from './auth.service.js';
import { readCookie, SESSION_COOKIE } from './session.service.js';

const OAUTH_STATE_COOKIE = 'fde_oauth_state';

class CallbackResponse {
  @ApiProperty({ type: String })
  userId!: string;
  @ApiProperty({ type: String })
  tenantId!: string;
  @ApiProperty({ type: String })
  email!: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.secureCookies = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  private cookieOpts(extra: { maxAge?: number; path: string }) {
    return { httpOnly: true, sameSite: 'lax' as const, secure: this.secureCookies, ...extra };
  }

  /**
   * Redirects to WorkOS AuthKit. A random `state` nonce is both sent to WorkOS
   * and stored in a short-lived cookie, so the callback can bind the response to
   * this browser (CSRF / login-confusion protection).
   */
  @Public()
  @Get('login')
  @ApiExcludeEndpoint()
  login(@Res() res: Response): void {
    const nonce = randomBytes(16).toString('base64url');
    res.cookie(OAUTH_STATE_COOKIE, nonce, this.cookieOpts({ maxAge: 600_000, path: '/auth' }));
    res.redirect(this.auth.loginUrl(nonce));
  }

  /**
   * WorkOS redirects back here with `?code` and the round-tripped `?state`.
   * Verifies `state` against the cookie, exchanges the code, upserts the user,
   * and sets the session as an httpOnly cookie. The token is not returned in the
   * body — clients read it from `Set-Cookie`.
   */
  @Public()
  @Get('callback')
  @ApiOkResponse({ type: CallbackResponse })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CallbackResponse> {
    if (!code) throw new BadRequestException('missing ?code');
    const expected = readCookie(req, OAUTH_STATE_COOKIE);
    if (!expected || !state || !safeEqual(expected, state)) {
      throw new UnauthorizedException('invalid or missing oauth state');
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' });

    const session = await this.auth.completeLogin(code);
    res.cookie(SESSION_COOKIE, session.token, this.cookieOpts({ path: '/' }));
    return { userId: session.userId, tenantId: session.tenantId, email: session.email };
  }
}
