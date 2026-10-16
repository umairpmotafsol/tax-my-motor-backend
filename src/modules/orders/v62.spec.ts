/**
 * The V62, from what the customer typed to the form an admin downloads.
 *
 * The builder is checked for what it insists on — an order must not be
 * taken with a V62 nobody can print — and the PDF for being a real,
 * one-page document with the answers on it.
 */
import { PDFDocument } from 'pdf-lib';

import { V62DataDto } from './dto/order.dto';
import { buildV62Submission, parseV62Date } from './v62.builder';
import { renderV62Pdf, splitHouseNumber, splitName, v62FileName } from './v62-pdf';

const vehicle = {
  make: 'Vauxhall',
  variant: '',
  colour: 'Silver',
  vin: 'W0LPF6ED9FG127064',
  taxClass: 'Petrol',
  year: 2015,
};
const customer = { name: 'Rebecca Scott', phone: '07715816586', email: 'becky@example.co.uk' };
const now = new Date(2026, 7, 28, 12);

const sameDetails: V62DataDto = {
  sameAsTaxDetails: true,
  dateAcquired: '26/09/2018',
  applicantTitle: 'Miss',
  applicantAddress1: '40 California Road',
  applicantAddress2: '',
  applicantCity: 'Carlisle',
  applicantPostcode: 'ca3 0by',
};

const build = (data: Partial<V62DataDto>, from = sameDetails) =>
  buildV62Submission({
    reg: 'dv65ywo',
    data: { ...from, ...data },
    vehicle,
    customer,
    fee: 40,
    now,
  });

describe('building the V62 from the checkout', () => {
  it('takes the name and contact from the account when the details are the same', () => {
    expect(build({})).toMatchObject({
      registrationNumber: 'DV65 YWO',
      make: 'VAUXHALL',
      colour: 'Silver',
      vin: 'W0LPF6ED9FG127064',
      taxClass: 'Petrol',
      reasonForNoV5C: 'Lost, stolen, damaged or destroyed',
      fee: 40,
      keeperTitle: 'Miss',
      keeperName: 'Rebecca Scott',
      keeperPhone: '07715816586',
      keeperEmail: 'becky@example.co.uk',
      keeperAddress: '40 California Road, Carlisle',
      keeperAddress1: '40 California Road',
      keeperCity: 'Carlisle',
      keeperPostcode: 'CA3 0BY',
      dateAcquired: '26/09/2018',
      declarationDate: '28 / 08 / 2026',
    });
  });

  it('ignores a name typed for somebody else once the details are the same', () => {
    expect(build({ applicantName: 'Somebody Else' }).keeperName).toBe('Rebecca Scott');
  });

  it('puts a different person on the form when the customer names one', () => {
    const v62 = build({
      sameAsTaxDetails: false,
      applicantTitle: 'Mr',
      applicantName: 'Tom Scott',
      applicantPhone: '07700 900123',
      applicantEmail: 'tom@example.co.uk',
      applicantAddress2: 'Flat 2',
    });

    expect(v62).toMatchObject({
      keeperTitle: 'Mr',
      keeperName: 'Tom Scott',
      keeperPhone: '07700 900123',
      keeperEmail: 'tom@example.co.uk',
      keeperAddress: '40 California Road, Flat 2, Carlisle',
    });
  });

  it('writes the year beside the make where the lookup has no model', () => {
    expect(build({}).model).toBe('2015 Vauxhall');
  });

  it('uses the model when the lookup has one', () => {
    const v62 = buildV62Submission({
      reg: 'AB12CDE',
      data: sameDetails,
      vehicle: { ...vehicle, variant: 'Corsa SE' },
      customer,
      fee: 40,
      now,
    });
    expect(v62.model).toBe('Corsa SE');
  });

  it.each([
    ['no date', { dateAcquired: undefined }],
    ['a date that does not exist', { dateAcquired: '31/02/2020' }],
    ['a date in another format', { dateAcquired: '2018-09-26' }],
    ['a date still to come', { dateAcquired: '01/01/2027' }],
  ])('refuses %s for when the vehicle was acquired', (_label, patch) => {
    expect(() => build(patch)).toThrow('Please provide the date acquired for the V62 request.');
  });

  it('accepts today as the date acquired', () => {
    expect(build({ dateAcquired: '28/08/2026' }).dateAcquired).toBe('28/08/2026');
  });

  it.each([[''], [undefined], ['Other'], ['Lord']])('refuses the title %p', title => {
    expect(() => build({ applicantTitle: title })).toThrow(
      'Please choose a title for the V62 request.',
    );
  });

  it.each([['applicantAddress1'], ['applicantCity'], ['applicantPostcode']])(
    'refuses an address with no %s',
    field => {
      expect(() => build({ [field]: ' ' })).toThrow(
        'Please provide your address details for the V62 request.',
      );
    },
  );

  it.each([['applicantName'], ['applicantPhone'], ['applicantEmail'], ['applicantCity']])(
    'refuses a different applicant with no %s',
    field => {
      const other = {
        ...sameDetails,
        sameAsTaxDetails: false,
        applicantName: 'Tom Scott',
        applicantPhone: '07700 900123',
        applicantEmail: 'tom@example.co.uk',
      };
      expect(() => build({ [field]: '' }, other)).toThrow(
        'Please complete all V62 applicant details.',
      );
    },
  );
});

describe('reading a V62 date', () => {
  it('reads DD/MM/YYYY', () => {
    expect(parseV62Date('26/09/2018')).toEqual(new Date(2018, 8, 26));
  });

  it('refuses a date that only exists by rolling over', () => {
    expect(parseV62Date('31/04/2024')).toBeNull();
  });
});

describe('fitting an address and a name to the form', () => {
  it.each([
    ['40 California Road', '40', 'California Road'],
    ['12B Bridge Street', '12B', 'Bridge Street'],
    ['1024, Long Lane', '1024', 'Long Lane'],
    ['Carlisle Golf Centre Ltd', '', 'Carlisle Golf Centre Ltd'],
    ['Flat 2, 40 California Road', '', 'Flat 2, 40 California Road'],
    ['40', '', '40'],
  ])('splits %p', (address, houseNumber, rest) => {
    expect(splitHouseNumber(address)).toEqual({ houseNumber, rest });
  });

  it('treats the last word of a name as the surname', () => {
    expect(splitName('Rebecca Jane Scott')).toEqual({
      firstNames: 'Rebecca Jane',
      surname: 'Scott',
    });
    expect(splitName('Cher')).toEqual({ firstNames: '', surname: 'Cher' });
  });

  it('names the download after the plate and the order', () => {
    expect(v62FileName('DV65 YWO', 'ORD-1042')).toBe('V62-DV65YWO-ORD-1042.pdf');
  });
});

describe('the V62 as a PDF', () => {
  it('draws a one-page A4 form', async () => {
    const bytes = await renderV62Pdf(build({}));

    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
    expect(Math.round(doc.getPage(0).getHeight())).toBe(842);
  });

  it('draws a name the form’s typeface has no letters for, rather than failing', async () => {
    const v62 = { ...build({}), keeperName: 'Zoë Łukasz 张伟', keeperEmail: 'zoë@example.co.uk' };
    await expect(renderV62Pdf(v62)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('draws an order placed before the address was taken in parts', async () => {
    const legacy = {
      ...build({}),
      keeperTitle: '',
      keeperAddress: '24 Maple Road, SW11 3AA',
      keeperAddress1: '',
      keeperAddress2: '',
      keeperCity: '',
      dateAcquired: '',
      vin: '',
    };
    await expect(renderV62Pdf(legacy)).resolves.toBeInstanceOf(Uint8Array);
  });
});
