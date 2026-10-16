import { BadRequestException } from '@nestjs/common';

import { formatReg, formatV62Date } from '../../common/utils/format.util';
import { V62DataDto } from './dto/order.dto';
import { V62Submission } from './schemas/order.schema';

/** The four boxes the printed form has. "Other" is a free-text box nobody is asked to fill. */
export const V62_TITLES = ['Mr', 'Mrs', 'Miss', 'Ms'];

/** What the lookup knows about the vehicle — the half of the form nobody types. */
export interface V62Vehicle {
  make: string;
  variant: string;
  colour: string;
  vin: string;
  taxClass: string;
  year?: number | null;
}

/** The account the order is placed on — the keeper, when the details are the same. */
export interface V62Customer {
  name: string;
  phone: string;
  email: string;
}

/**
 * DD/MM/YYYY, and a date that exists. 31/02/2020 parses in JavaScript by
 * rolling over into March, so the round trip is what catches it — the
 * same check the mandate's date of birth gets.
 */
export function parseV62Date(value: string): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((value ?? '').trim());
  if (!match) {
    return null;
  }
  const [, dd, mm, yyyy] = match;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  const roundTrips =
    date.getFullYear() === Number(yyyy) &&
    date.getMonth() === Number(mm) - 1 &&
    date.getDate() === Number(dd);
  return roundTrips ? date : null;
}

/**
 * The customer's V62Data merged with the lookup into the printed form.
 *
 * Validated here as well as in the app, in the order the form reads, so
 * an order cannot be taken and paid for with a V62 the admin then has
 * nothing to print from. The applicant fields always describe the
 * person going on the form: with the details the same, their name and
 * contact come from the account and only what the account does not
 * hold — a title and a postal address — is read from what was typed.
 */
export function buildV62Submission(input: {
  reg: string;
  data: V62DataDto;
  vehicle: V62Vehicle;
  customer: V62Customer;
  fee: number;
  now?: Date;
}): V62Submission {
  const { data, vehicle, customer } = input;
  const now = input.now ?? new Date();
  const sameAsTaxDetails = data.sameAsTaxDetails !== false;

  const acquired = parseV62Date(data.dateAcquired ?? '');
  /* A day's grace, because the customer's "today" may already be the server's tomorrow. */
  if (
    !acquired ||
    acquired.getFullYear() < 1900 ||
    acquired.getTime() > now.getTime() + 86_400_000
  ) {
    throw new BadRequestException('Please provide the date acquired for the V62 request.');
  }

  const title = (data.applicantTitle ?? '').trim();
  const address1 = (data.applicantAddress1 ?? '').trim();
  const address2 = (data.applicantAddress2 ?? '').trim();
  const city = (data.applicantCity ?? '').trim();
  const postcode = (data.applicantPostcode ?? '').trim().toUpperCase();

  const name = sameAsTaxDetails ? customer.name : (data.applicantName ?? '').trim();
  const phone = sameAsTaxDetails ? customer.phone : (data.applicantPhone ?? '').trim();
  const email = sameAsTaxDetails ? customer.email : (data.applicantEmail ?? '').trim();

  if (
    !sameAsTaxDetails &&
    (!title || !name || !phone || !email || !address1 || !city || !postcode)
  ) {
    throw new BadRequestException('Please complete all V62 applicant details.');
  }
  if (!V62_TITLES.includes(title)) {
    throw new BadRequestException('Please choose a title for the V62 request.');
  }
  if (!address1 || !city || !postcode) {
    throw new BadRequestException('Please provide your address details for the V62 request.');
  }

  return {
    registrationNumber: formatReg(input.reg),
    make: vehicle.make.toUpperCase(),
    /*
     * The form asks for make and model on separate lines. Where the
     * lookup has no model, the year stands in beside the make — which
     * is what a keeper without the V5C in front of them writes too.
     */
    model: vehicle.variant || [vehicle.year, vehicle.make].filter(Boolean).join(' '),
    colour: vehicle.colour,
    vin: vehicle.vin,
    taxClass: vehicle.taxClass,
    reasonForNoV5C: data.reasonForNoV5C || 'Lost, stolen, damaged or destroyed',
    fee: input.fee,
    keeperTitle: title,
    keeperName: name,
    keeperAddress: [address1, address2, city].filter(Boolean).join(', '),
    keeperAddress1: address1,
    keeperAddress2: address2,
    keeperCity: city,
    keeperPostcode: postcode,
    keeperPhone: phone,
    keeperEmail: email,
    dateAcquired: data.dateAcquired!.trim(),
    declarationDate: formatV62Date(now),
    submittedAt: now,
  };
}
