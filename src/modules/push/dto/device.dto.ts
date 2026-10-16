import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RegisterDeviceDto {
  /** The FCM registration token. Long, opaque, and rotated by the SDK. */
  @IsString()
  @IsNotEmpty({ message: 'A device token is required.' })
  @MaxLength(4096)
  @Transform(trim)
  token!: string;

  @IsIn(['ios', 'android'], { message: 'Platform must be ios or android.' })
  platform!: 'ios' | 'android';
}

export class ForgetDeviceDto {
  @IsString()
  @IsNotEmpty({ message: 'A device token is required.' })
  @MaxLength(4096)
  @Transform(trim)
  token!: string;
}
