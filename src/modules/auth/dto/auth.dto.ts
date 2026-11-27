import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RegisterDto {
  /*
   * A first and last name, or — from app builds older than the split —
   * one whole name. `AuthService.register` insists on one or the other.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(trim)
  email!: string;

  /**
   * Eight is the floor, not the advice. Length is the only rule worth
   * enforcing — a composition rule pushes people towards "Passw0rd!".
   */
  @IsString()
  @MinLength(8, { message: 'Your password needs to be at least 8 characters.' })
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  address?: string;

  /** The code of whoever invited them, if they came in on a referral. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  referralCode?: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(trim)
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'Please enter your password.' })
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Please enter your current password.' })
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'Your new password needs to be at least 8 characters.' })
  @MaxLength(128)
  newPassword!: string;

  /** This device's session, kept signed in while every other one is signed out. */
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(trim)
  email!: string;
}

export class VerifyResetCodeDto {
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(trim)
  email!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from the email.' })
  @Transform(trim)
  code!: string;
}

export class ResetPasswordDto extends VerifyResetCodeDto {
  @IsString()
  @MinLength(8, { message: 'Your new password needs to be at least 8 characters.' })
  @MaxLength(128)
  newPassword!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Please enter your first name.' })
  @MaxLength(60)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Please enter your last name.' })
  @MaxLength(60)
  @Transform(trim)
  lastName?: string;

  /** The whole name, as app builds older than the split still send it. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  /**
   * Editable because the details step offers it, and the invoice goes
   * wherever this points — an address the customer corrects there has
   * to actually take. It is also the login identifier, so
   * `UsersService.updateProfile` checks it is still free before it
   * moves.
   */
  @IsOptional()
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(trim)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Transform(trim)
  postcode?: string;
}
