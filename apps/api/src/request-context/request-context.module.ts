import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from '../auth/auth.module.js';
import { TenantContextGuard } from './tenant-context.guard.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';

/**
 * Wires the two halves of the request-context seam as app-wide providers:
 * `TenantContextGuard` (auth → 401 before any DB work) then
 * `TenantContextInterceptor` (opens `withTenant` / `withEngagement` around the
 * handler). Order matters and Nest guarantees it: guards run before interceptors.
 */
@Module({
  imports: [AuthModule],
  providers: [
    { provide: APP_GUARD, useClass: TenantContextGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class RequestContextModule {}
