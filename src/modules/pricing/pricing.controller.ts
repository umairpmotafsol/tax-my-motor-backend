import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

import { Public } from '../../common/decorators/public.decorator';
import { VehicleTaxInfo, VehiclesService } from '../vehicles/vehicles.service';
import { PricingService, TaxOptionId, VedRates } from './pricing.service';

class QuoteDto {
  @IsIn(['6m', '12m', 'dd'], { message: 'Please choose a tax option.' })
  option!: TaxOptionId;

  /** Required now that the price depends on the vehicle, not on a table. */
  @IsString({ message: 'Please enter a registration.' })
  reg!: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  v62?: boolean;
}

class OptionsQueryDto {
  /**
   * Optional, because the app asks for this at boot to pick up the fees
   * and the publishable key, before anyone has typed a plate. Without
   * it the terms come back unpriced rather than priced wrongly.
   */
  @IsOptional()
  @IsString()
  reg?: string;
}

/** What the apps are told about the vehicle's current tax, alongside the price. */
const taxSummary = (info: VehicleTaxInfo) => ({
  status: info.taxStatus,
  isTaxed: info.isTaxed,
  dueDate: info.taxDueDate,
  daysRemaining: info.daysRemaining,
  motStatus: info.motStatus,
  band: info.ved?.band ?? null,
  checkedAt: info.checkedAt,
  stale: info.stale,
});

@ApiTags('pricing')
@Controller('pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly vehicles: VehiclesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Public: the customer app prices a quote before anyone signs in, and
   * this is also where it picks up the Stripe publishable key — safe to
   * hand out, it only lets the app open a checkout sheet, never charge
   * anything on its own.
   */
  @Public()
  @Get('options')
  @ApiOperation({ summary: 'The tax options for a vehicle, and the fees that apply' })
  async options(@Query() query: OptionsQueryDto) {
    const fees = {
      serviceFee: this.pricing.serviceFee,
      v62Fee: this.pricing.v62Fee,
      stripePublishableKey: this.config.get<string>('stripe.publishableKey') ?? '',
    };

    if (!query.reg) {
      return { ...fees, options: [], tax: null, priced: false };
    }

    const info = await this.vehicles.vedFor(query.reg);
    return {
      ...fees,
      options: this.pricing.listOptions(ratesOf(info)),
      tax: taxSummary(info),
      priced: true,
    };
  }

  @Public()
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Price a basket for a vehicle' })
  async quote(@Body() dto: QuoteDto) {
    const withV62 = dto.v62 === true;
    const info = await this.vehicles.vedFor(dto.reg);
    return {
      option: dto.option,
      v62: withV62,
      planLabel: this.pricing.planLabel(dto.option, withV62),
      items: this.pricing.itemsFor(dto.option, withV62),
      pricing: this.pricing.price(dto.option, withV62, ratesOf(info)),
      tax: taxSummary(info),
    };
  }
}

const ratesOf = (info: VehicleTaxInfo): VedRates => ({
  sixMonth: info.ved?.sixMonth ?? null,
  twelveMonth: info.ved?.twelveMonth ?? null,
});
