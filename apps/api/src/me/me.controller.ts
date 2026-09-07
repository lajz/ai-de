import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { users } from '@fde/db';
import { eq } from 'drizzle-orm';

import { getRequestContext } from '../request-context/request-context.js';

class MeResponse {
  @ApiProperty({ type: String })
  userId!: string;
  @ApiProperty({ type: String })
  tenantId!: string;
  @ApiProperty({ type: String })
  email!: string;
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;
  @ApiProperty({ type: String, enum: ['active', 'disabled'] })
  status!: 'active' | 'disabled';
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  /** The authenticated user's own `users` row, read through the request's RLS tx. */
  @Get()
  @ApiOkResponse({ type: MeResponse })
  async me(): Promise<MeResponse> {
    const { userId, tenantId, tx } = getRequestContext();
    const [row] = await tx
      .select({ email: users.email, name: users.name, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) throw new NotFoundException('no users row for the current session');
    return { userId, tenantId, email: row.email, name: row.name, status: row.status };
  }
}
