import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

import { TaxOptionId } from '../../pricing/pricing.service';

/** Same shape the quote endpoint takes — a card is raised for the same basket that was priced. */
export class CreateIntentDto {
  @IsIn(['6m', '12m', 'dd'], { message: 'Please choose a tax option.' })
  option!: TaxOptionId;

  /** The price depends on the vehicle, so the charge does too. */
  @IsString({ message: 'Please enter a registration.' })
  reg!: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  v62?: boolean;
}
