/**
 * The example response published on
 * vehicledataglobal.com/DataSources/VehicleTaxDetails, kept verbatim.
 *
 * Two jobs. It is what the mapper is written against, so the field
 * names in `VehiclesService` can be checked without a live key; and in
 * development it stands in for a real lookup, so building the tax
 * screens costs nothing. It is never served in production — see
 * `VehicleDataClient.fetchTax`.
 */
export const VEHICLE_TAX_SAMPLE = {
  Results: {
    VehicleTaxDetails: {
      Vrm: 'AP52HOW',
      Make: 'VOLKSWAGEN',
      Co2Emissions: 192,
      MotStatus: 'Valid',
      YearOfManufacture: 2002,
      TaxDueDate: '2026-03-01T00:00:00',
      TaxStatus: 'Taxed',
      TaxIsCurrentlyValid: true,
      TaxDaysRemaining: 297,
      VehicleExciseDutyDetails: {
        DvlaCo2: 192,
        DvlaCo2Band: 'J',
        DvlaBand: 'J',
        VedRate: {
          FirstYear: { SixMonths: null, TwelveMonths: null },
          PremiumVehicle: { SixMonths: null, TwelveMonths: null },
          Standard: { SixMonths: 217.25, TwelveMonths: 395 },
        },
      },
      StatusCode: 0,
      StatusMessage: 'Success',
      DocumentVersion: 1,
    },
  },
} as const;
