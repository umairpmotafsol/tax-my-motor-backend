import { Module } from '@nestjs/common';

import { AddressLookupClient } from './address-lookup.client';
import { AddressesController } from './addresses.controller';

@Module({
  controllers: [AddressesController],
  providers: [AddressLookupClient],
})
export class AddressesModule {}
