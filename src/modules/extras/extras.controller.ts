import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import {
  PlatesDetailsDto,
  PlatesOrderDto,
  PlatesRegDto,
  VinPurchaseDto,
  VinRegDto,
} from './dto/extras.dto';
import { PlatesService, toPlateOrder } from './plates.service';
import { VinService, toVinPurchase } from './vin.service';

/**
 * The Extras tab: small paid services beside the tax order itself.
 * Flat-priced — the £40 service fee belongs to tax orders, not these.
 */
@ApiTags('extras')
@Roles(Role.Customer)
@Controller('extras')
export class ExtrasController {
  constructor(
    private readonly vin: VinService,
    private readonly plates: PlatesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'What the Extras tab sells, and for how much' })
  prices() {
    return { vin: { price: this.vin.price }, plates: { price: this.plates.price } };
  }

  /**
   * Throttled hard: a plate not already cached is a paid lookup, made
   * here before the customer has paid anything.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('vin/check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether a VIN can be sold for this registration — not the VIN' })
  check(@Body() dto: VinRegDto) {
    return this.vin.check(dto.reg);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('vin/intent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start the card payment for a VIN' })
  intent(@CurrentUser() user: AuthUser, @Body() dto: VinRegDto) {
    return this.vin.createIntent(dto.reg, user.userId);
  }

  @Post('vin')
  @ApiOperation({ summary: 'Complete a paid VIN purchase and receive the VIN' })
  async purchase(@CurrentUser() user: AuthUser, @Body() dto: VinPurchaseDto) {
    return toVinPurchase(await this.vin.purchase(dto.reg, dto.paymentIntentId, user.userId));
  }

  @Get('vin')
  @ApiOperation({ summary: 'My VIN purchases, newest first' })
  async list(@CurrentUser() user: AuthUser) {
    return (await this.vin.listForCustomer(user.userId)).map(toVinPurchase);
  }

  /* ----------------------------- number plates ----------------------------- */

  /** Throttled: a plate not already cached is a paid lookup. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('plates/check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The vehicle and price for a number plates order' })
  checkPlates(@Body() dto: PlatesRegDto) {
    return this.plates.check(dto.reg);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('plates/intent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start the card payment for number plates' })
  platesIntent(@CurrentUser() user: AuthUser, @Body() dto: PlatesDetailsDto) {
    return this.plates.createIntent(dto, user.userId);
  }

  @Post('plates')
  @ApiOperation({ summary: 'Place a paid number plates order' })
  async placePlates(@CurrentUser() user: AuthUser, @Body() dto: PlatesOrderDto) {
    const { paymentIntentId, ...details } = dto;
    return toPlateOrder(await this.plates.place(details, paymentIntentId, user.userId));
  }

  @Get('plates')
  @ApiOperation({ summary: 'My number plates orders, newest first' })
  async listPlates(@CurrentUser() user: AuthUser) {
    return (await this.plates.listForCustomer(user.userId)).map(toPlateOrder);
  }
}
