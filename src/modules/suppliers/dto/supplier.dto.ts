import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { OrderType, SupplierStatus } from '../../../common/enums/order.enum';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Transform(trim)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  @Transform(trim)
  company!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  contact?: string;

  @IsOptional()
  @IsEmail()
  @Transform(trim)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  region?: string;

  @IsOptional()
  @IsEnum(SupplierStatus)
  status?: SupplierStatus;

  /** Handed over exclusively — whoever held these types loses them. */
  @IsOptional()
  @IsArray()
  @IsEnum(OrderType, { each: true })
  orderTypes?: OrderType[];
}

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

export class SetSupplierStatusDto {
  @IsEnum(SupplierStatus)
  status!: SupplierStatus;
}

/**
 * Creating the login that goes with a supplier. Kept separate from the
 * supplier record: the company is one thing, the person who signs in on
 * its behalf is another, and a supplier can outlive any one of them.
 *
 * Only the email address is required, because only the email address is
 * the supplier's to give. The name falls back to the contact already on
 * the supplier record, and an omitted password is generated — which is
 * the normal case: nobody should be inventing a password on a
 * colleague's behalf, and one that is generated and shown once is
 * harder to reuse from somewhere else.
 */
export class CreateSupplierUserDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @IsEmail({}, { message: 'That does not look like an email address.' })
  @Transform(trim)
  email!: string;

  /** Omit it — see above. Present only for restoring a known password. */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'A password needs to be at least 8 characters.' })
  @MaxLength(128)
  password?: string;
}
