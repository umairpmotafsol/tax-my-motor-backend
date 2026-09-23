import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { CreateIntentDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly payments: PaymentsService) {}

  @Roles(Role.Customer)
  @Post('intent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a card payment for the priced basket' })
  async createIntent(@CurrentUser() user: AuthUser, @Body() dto: CreateIntentDto) {
    return this.payments.createIntent(dto.option, dto.v62 === true, user.userId, dto.reg);
  }

  /**
   * Stripe calls this directly, unauthenticated but signed — the
   * signature is the auth. Verified here for Stripe's own requirements
   * (disputes, refunds, async payment methods); an order is never
   * created off the back of this event, only off a directly-verified
   * PaymentIntent at placement time, so a missed or delayed webhook
   * can't block checkout.
   */
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    if (!req.rawBody || !signature) {
      throw new BadRequestException('Missing signature or body.');
    }
    const event = this.payments.constructWebhookEvent(req.rawBody, signature);
    this.logger.log('Stripe event received: ' + event.type);
    return { received: true };
  }
}
