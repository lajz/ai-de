import { BadRequestException, Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../request-context/metadata.js';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE } from './session.service.js';

class CallbackResponse {
  @ApiProperty({
    type: String,
    description: 'opaque session token — also set as the fde_session cookie',
  })
  token!: string;
  @ApiProperty({ type: String })
  userId!: string;
  @ApiProperty({ type: String })
  tenantId!: string;
  @ApiProperty({ type: String })
  email!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Redirects to WorkOS AuthKit for login. */
  @Public()
  @Get('login')
  @ApiExcludeEndpoint()
  login(@Query('state') state: string | undefined, @Res() res: Response): void {
    res.redirect(this.auth.loginUrl(state));
  }

  /**
   * WorkOS redirects back here with `?code`. Exchanges it, upserts the user,
   * mints a session, sets it as an httpOnly cookie, and also returns the opaque
   * token in the body for non-browser clients.
   */
  @Public()
  @Get('callback')
  @ApiOkResponse({ type: CallbackResponse })
  async callback(
    @Query('code') code: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CallbackResponse> {
    if (!code) throw new BadRequestException('missing ?code');
    const session = await this.auth.completeLogin(code);
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
    return {
      token: session.id,
      userId: session.userId,
      tenantId: session.tenantId,
      email: session.email,
    };
  }
}
