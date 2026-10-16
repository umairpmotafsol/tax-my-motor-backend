import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PlateOrderStatus } from '../schemas/plate-order.schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class VinRegDto {
  @IsString()
  @IsNotEmpty({ message: 'Please enter your registration number.' })
  @MaxLength(12)
  @Transform(trim)
  reg!: string;
}

export class VinPurchaseDto extends VinRegDto {
  /** The Stripe PaymentIntent from POST /extras/vin/intent, confirmed on the customer's device. */
  @IsString()
  @IsNotEmpty({ message: 'Payment is required.' })
  @Transform(trim)
  paymentIntentId!: string;
}

/** Number plates, step 1: the registration alone. */
export class PlatesRegDto extends VinRegDto {}

/** Number plates, steps 2 and 3: the registration and who the plates go to. */
export class PlatesDetailsDto extends PlatesRegDto {
  @IsString()
  @MinLength(2, { message: 'Please enter your full name.' })
  @MaxLength(120)
  @Transform(trim)
  name!: string;

  /** At least nine digits, whatever the spacing or a leading +44. */
  @IsString()
  @Matches(/^(?:\D*\d){9,}\D*$/, { message: 'Please enter your mobile number.' })
  @MaxLength(30)
  @Transform(trim)
  phone!: string;

  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @MaxLength(200)
  @Transform(trim)
  email!: string;

  @IsString()
  @MinLength(5, { message: 'Please enter your home address.' })
  @MaxLength(300)
  @Transform(trim)
  address!: string;
}

export class PlatesOrderDto extends PlatesDetailsDto {
  /** The Stripe PaymentIntent from POST /extras/plates/intent, confirmed on the customer's device. */
  @IsString()
  @IsNotEmpty({ message: 'Payment is required.' })
  @Transform(trim)
  paymentIntentId!: string;
}

export class ListPlateOrdersDto extends PaginationDto {
  @IsOptional()
  @IsEnum(PlateOrderStatus)
  status?: PlateOrderStatus;
}

export class UpdatePlateStatusDto {
  @IsEnum(PlateOrderStatus, { message: 'That is not a number plates status.' })
  status!: PlateOrderStatus;
}
