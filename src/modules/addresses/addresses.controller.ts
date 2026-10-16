import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { AddressLookupClient, AddressLookupError } from './address-lookup.client';

class AddressLookupDto {
  @IsString()
  @IsNotEmpty({ message: 'Enter a postcode first.' })
  @MaxLength(16)
  postcode!: string;
}

@ApiTags('addresses')
@Controller('addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressLookupClient) {}

  /**
   * "Find address" on the V62 screen.
   *
   * Signed-in callers only — checkout is behind sign-in, so nobody who
   * needs this lacks a token, and a metered search is not left open to
   * the internet. Throttled besides, for the same reason.
   *
   * Every failure says the same last thing: the address can be typed
   * instead. The app shows these messages as they are.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('lookup')
  @ApiOperation({ summary: 'The addresses at a UK postcode' })
  async lookup(@Query() query: AddressLookupDto) {
    try {
      return await this.addresses.find(query.postcode);
    } catch (err) {
      if (!(err instanceof AddressLookupError)) {
        throw err;
      }
      switch (err.reason) {
        case 'invalid-postcode':
          throw new BadRequestException(
            'Enter a valid UK postcode, or enter the address manually.',
          );
        case 'not-found':
          throw new NotFoundException(
            'We could not find an address for that postcode. You can enter it manually.',
          );
        default:
          throw new ServiceUnavailableException(
            'Address search is unavailable. You can enter the address manually.',
          );
      }
    }
  }
}
