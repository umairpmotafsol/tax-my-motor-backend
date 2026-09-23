import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { BankField } from '../../../common/enums/bank.enum';
import { CommunicationMethod, OrderStatus, OrderType } from '../../../common/enums/order.enum';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { TaxOptionId } from '../../pricing/pricing.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** The Direct Debit mandate, as the customer typed it. */
export class BankDetailsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  accountHolder!: string;

  @IsString()
  @IsNotEmpty()
  @Transform(trim)
  accountNumber!: string;

  @IsString()
  @IsNotEmpty()
  @Transform(trim)
  sortCode!: string;

  /** DD/MM/YYYY. Checked against the mandate rules, not just the format. */
  @IsString()
  @IsNotEmpty()
  @Transform(trim)
  dateOfBirth!: string;
}

/**
 * What the checkout asks for when V62 is added: only, if the applicant
 * is not the person who filled in "Your details", who to put on the
 * form. Everything else DVLA needs is known from the vehicle lookup.
 */
export class V62DataDto {
  @IsBoolean()
  sameAsTaxDetails!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Transform(trim)
  applicantTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  applicantName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  applicantPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(trim)
  applicantEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Transform(trim)
  applicantPostcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  applicantAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  reasonForNoV5C?: string;
}

export class PlaceOrderDto {
  @IsString()
  @IsNotEmpty({ message: 'Please enter your registration number.' })
  @Transform(trim)
  reg!: string;

  @IsIn(['6m', '12m', 'dd'], { message: 'Please choose a tax option.' })
  option!: TaxOptionId;

  @IsOptional()
  @IsBoolean()
  v62?: boolean;

  @IsEnum(CommunicationMethod)
  channel!: CommunicationMethod;

  /** Where the invoice goes. Defaults to the profile when left out. */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(trim)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  whatsapp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  deliveryAddress?: string;

  /** Required when the option is Direct Debit. */
  @IsOptional()
  @ValidateNested()
  @Type(() => BankDetailsDto)
  bank?: BankDetailsDto;

  /** Required when v62 is true. */
  @IsOptional()
  @ValidateNested()
  @Type(() => V62DataDto)
  v62Data?: V62DataDto;

  /**
   * The Stripe PaymentIntent from POST /payments/intent, confirmed on
   * the customer's device. Required for 6 and 12 month tax — Direct
   * Debit is collected by DVLA, not charged here.
   */
  @IsOptional()
  @IsString()
  @Transform(trim)
  paymentIntentId?: string;
}

/** The customer's half of the review loop: corrected details, sent back. */
export class ResubmitBankDto {
  @ValidateNested()
  @Type(() => BankDetailsDto)
  bank!: BankDetailsDto;
}

/** The supplier's half: name what is wrong and hand it back. */
export class RequestBankChangesDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Say which fields are wrong.' })
  @IsEnum(BankField, { each: true })
  fields!: BankField[];

  @IsString()
  @IsNotEmpty({ message: 'Tell the customer what to fix.' })
  @MaxLength(500)
  @Transform(trim)
  message!: string;
}

export class ReassignOrderDto {
  @IsString()
  @IsNotEmpty()
  supplierId!: string;
}

/** Filters behind the admin order list and the supplier's own list. */
export class ListOrdersDto extends PaginationDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(OrderType)
  orderType?: OrderType;

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsIn(['open', 'closed', 'all'])
  bucket?: 'open' | 'closed' | 'all';

  /** Placed since midnight — what the admin's "today" view means. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  today?: boolean;
}
