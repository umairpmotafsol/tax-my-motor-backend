import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transporter, createTransport } from 'nodemailer';

import { AppConfig } from '../../config/configuration';

/**
 * The SMTP transport, or null when the app is running without mail
 * settings.
 *
 * Behind an injection token for the same reason the Firebase sender is
 * (see push.provider.ts): opening a connection to a mail server is the
 * one part of sending an email a test cannot exercise, so the service is
 * handed a transport and a test hands it one that records what it was
 * asked to send.
 */
export const MAIL_TRANSPORT = 'MAIL_TRANSPORT';

/** What MailService needs of nodemailer — and all a test has to stand in for. */
export type MailSender = Pick<Transporter, 'sendMail'>;

export const mailTransportProvider: Provider = {
  provide: MAIL_TRANSPORT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): MailSender | null => {
    const logger = new Logger('Mail');
    const mail = config.get<AppConfig['mail']>('mail');

    /*
     * Missing settings switch email off rather than stopping the boot,
     * so a developer without an SMTP account still runs the whole app.
     * An order whose invoice could not be emailed says so on its
     * timeline — off is never reported as sent.
     */
    if (!mail?.host || !mail.username || !mail.password || !mail.from) {
      logger.warn(
        'SMTP is not fully configured (SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD) — ' +
          'invoices will not be emailed to customers.',
      );
      return null;
    }

    logger.log('Email is on (' + mail.host + ':' + mail.port + ', from ' + mail.from + ').');
    return createTransport({
      host: mail.host,
      port: mail.port,
      /* 465 is TLS from the first byte; 587 and 25 upgrade with STARTTLS. */
      secure: mail.port === 465,
      auth: { user: mail.username, pass: mail.password },
      /*
       * A mail server that has stopped answering must not hold a
       * request open: the send happens after the supplier's upload has
       * been answered, but an admin's resend waits on it.
       */
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  },
};
