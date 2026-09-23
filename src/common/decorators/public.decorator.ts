import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opens an endpoint to unauthenticated callers (sign-in, health, lookup). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
