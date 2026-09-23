import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { Role } from '../enums/role.enum';

/** What the access token carries, and what every guarded handler gets. */
export interface AuthUser {
  userId: string;
  email: string;
  role: Role;
  /** Set for suppliers only — scopes them to their own order book. */
  supplierId?: string;
  name: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) {
      return undefined;
    }
    return data ? user[data] : user;
  },
);
