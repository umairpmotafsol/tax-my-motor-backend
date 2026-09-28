/**
 * Real responses from Vehicle Data Global, trimmed to the vehicle fields
 * (no VIN, keeper, plate or V5C history), for the two plates the DVLA
 * table fallback was built for. Both came back with every VedRate
 * table empty — the provider had no price for either.
 *
 * RE23 YRU: a 2023 Land Rover Discovery Sport, list price £47,805 new.
 * YD23 OGM: a 2023 Toyota Corolla hybrid.
 *
 * Looked up on 28 September 2026.
 */

/** VehicleDetails package, RE23 YRU. */
export const RE23YRU_DETAILS = {
  Results: {
    VehicleDetails: {
      VehicleIdentification: {
        Vrm: 'RE23YRU',
        DvlaMake: 'LAND ROVER',
        DvlaModel: 'DISCOVERY SPORT RDYN SE MHEV A',
        DvlaWheelPlan: '2 AXLE RIGID BODY',
        DateFirstRegisteredInUk: '2023-06-19T00:00:00Z',
        DateFirstRegistered: '2023-06-19T00:00:00Z',
        DateOfManufacture: '2023-06-19T00:00:00Z',
        YearOfManufacture: 2023,
        DvlaBodyType: 'ESTATE',
        DvlaFuelType: 'PETROL',
      },
      VehicleStatus: {
        VehicleExciseDutyDetails: {
          DvlaCo2: 212,
          DvlaCo2Band: null,
          DvlaBand: null,
          VedRate: {
            FirstYear: {
              SixMonths: null,
              TwelveMonths: null,
            },
            PremiumVehicle: {
              SixMonths: null,
              TwelveMonths: null,
            },
            Standard: {
              SixMonths: null,
              TwelveMonths: null,
            },
          },
        },
      },
      VehicleHistory: {
        ColourDetails: {
          CurrentColour: 'BLACK',
        },
      },
      DvlaTechnicalDetails: {
        NumberOfSeats: 7,
        EngineCapacityCc: 1997,
        GrossWeightKg: 2063,
        MaxNetPowerKw: null,
        MassInServiceKg: 2063,
        PowerToWeightRatio: 0,
        MaxPermissibleBrakedTrailerMassKg: 2000,
        MaxPermissibleUnbrakedTrailerMassKg: 750,
      },
      StatusCode: 0,
      StatusMessage: 'Success',
    },
    ModelDetails: {
      ModelIdentification: {
        Make: 'Land Rover',
        Range: 'Discovery Sport',
        Model: 'Discovery Sport R-Dynamic SE MHEV Auto',
      },
      ModelClassification: {
        TypeApprovalCategory: 'M1',
        MarketSectorCode: 'AA',
        VehicleClass: 'Car',
        TaxationClass: 'Car',
      },
      BodyDetails: {
        BodyStyle: 'SUV',
        NumberOfAxles: 2,
        NumberOfSeats: 7,
      },
      Weights: {
        KerbWeightKg: 1942,
        GrossTrainWeightKg: 4550,
        UnladenWeightKg: null,
        PayloadWeightKg: null,
        GrossVehicleWeightKg: 2063,
        GrossCombinedWeightKg: 2700,
      },
      Powertrain: {
        PowertrainType: 'MHEV',
        FuelType: 'Petrol',
        IceDetails: {
          EngineCapacityCc: 1997,
        },
      },
      Emissions: {
        EuroStatus: '6d',
        ManufacturerCo2: 185,
      },
      StatusCode: 0,
      StatusMessage: 'Success',
    },
  },
} as const;

/** VehicleDetails package, YD23 OGM. */
export const YD23OGM_DETAILS = {
  Results: {
    VehicleDetails: {
      VehicleIdentification: {
        Vrm: 'YD23OGM',
        DvlaMake: 'TOYOTA',
        DvlaModel: 'COROLLA ICON HEV CVT',
        DvlaWheelPlan: '2 AXLE RIGID BODY',
        DateFirstRegisteredInUk: '2023-06-06T00:00:00Z',
        DateFirstRegistered: '2023-06-06T00:00:00Z',
        DateOfManufacture: '2023-06-06T00:00:00Z',
        YearOfManufacture: 2023,
        DvlaBodyType: 'ESTATE',
        DvlaFuelType: 'HYBRID ELECTRIC',
      },
      VehicleStatus: {
        VehicleExciseDutyDetails: {
          DvlaCo2: 101,
          DvlaCo2Band: null,
          DvlaBand: null,
          VedRate: {
            FirstYear: {
              SixMonths: null,
              TwelveMonths: null,
            },
            PremiumVehicle: {
              SixMonths: null,
              TwelveMonths: null,
            },
            Standard: {
              SixMonths: null,
              TwelveMonths: null,
            },
          },
        },
      },
      VehicleHistory: {
        ColourDetails: {
          CurrentColour: 'GREY',
        },
      },
      DvlaTechnicalDetails: {
        NumberOfSeats: 5,
        EngineCapacityCc: 1798,
        GrossWeightKg: null,
        MaxNetPowerKw: 72,
        MassInServiceKg: 1486,
        PowerToWeightRatio: 0,
        MaxPermissibleBrakedTrailerMassKg: 750,
        MaxPermissibleUnbrakedTrailerMassKg: 450,
      },
      StatusCode: 0,
      StatusMessage: 'Success',
    },
    ModelDetails: {
      ModelIdentification: {
        Make: 'Toyota',
        Range: 'Corolla',
        Model: 'Corolla Icon HEV CVT',
      },
      ModelClassification: {
        TypeApprovalCategory: 'M1',
        MarketSectorCode: null,
        VehicleClass: 'Car',
        TaxationClass: 'Car',
      },
      BodyDetails: {
        BodyStyle: 'Estate',
        NumberOfAxles: 2,
        NumberOfSeats: 5,
      },
      Weights: {
        KerbWeightKg: 1480,
        GrossTrainWeightKg: 2635,
        UnladenWeightKg: null,
        PayloadWeightKg: null,
        GrossVehicleWeightKg: 1885,
        GrossCombinedWeightKg: 1885,
      },
      Powertrain: {
        PowertrainType: 'FHEV',
        FuelType: 'Petrol/Electric',
        IceDetails: {
          EngineCapacityCc: 1798,
        },
      },
      Emissions: {
        EuroStatus: '6d',
        ManufacturerCo2: 101,
      },
      StatusCode: 0,
      StatusMessage: 'Success',
    },
  },
} as const;

/** ValuationDetails package, RE23 YRU. `OnTheRoad` is the price when new. */
export const RE23YRU_VALUATION = {
  Results: {
    ValuationDetails: {
      VehicleDescription:
        'Land Rover Discovery Sport R-Dynamic SE MHEV Auto R-Dynamic SE [Petrol / Automatic]',
      DateOfFirstRegistration: '2023-06-19T00:00:00Z',
      ValuationFigures: {
        OnTheRoad: 47805,
        DealerForecourt: 27112,
        TradeRetail: 26193,
        PrivateClean: 24213,
        PrivateAverage: 23950,
        PartExchange: 23837,
        Auction: 23823,
        TradeAverage: 23018,
        TradePoor: 21432,
      },
      StatusCode: 0,
      StatusMessage: 'Success',
    },
  },
} as const;
