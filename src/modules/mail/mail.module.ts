import { Module } from '@nestjs/common';

import { mailTransportProvider } from './mail.provider';
import { MailService } from './mail.service';

/** Outgoing email. Off, and harmlessly so, when no SMTP settings are present. */
@Module({
  providers: [mailTransportProvider, MailService],
  exports: [MailService],
})
export class MailModule {}
