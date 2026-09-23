import { SetMetadata } from '@nestjs/common';

import { Role } from '../enums/role.enum';

export const ROLES_KEY = 'roles';

/** Restricts a route to the listed roles. Enforced by RolesGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
