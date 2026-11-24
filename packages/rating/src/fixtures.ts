import type { ManualDocument, RatingRequest } from '@astra/contracts';

/**
 * TEST FIXTURE: NOT A FILED MANUAL. It holds only the Delaware Trip Cancellation (RETR-SP-VU-DE-0426)
 * values that the product specification and backlog quote; every other row of the filed tables is
 * missing. It exists to test the engine and can never be published (no filing, no parity cases).
 */
export const SPEC_QUOTED_DE_TCAN: ManualDocument = {
  baseLossCost: '1.475',
  exposure: { kind: 'per_100_trip_cost', table: '2.1.5' },
  minimumTripCost: { from: '1', to: '500', ratesAs: '500' },
  variables: [
    { label: 'Age and pre-existing waiver', tables: ['2.1.4'] },
    { label: 'Departure month', tables: ['2.1.7'] },
    { label: 'Days before departure at purchase', tables: ['2.1.8'] },
    { label: 'Destination', tables: ['2.1.9'] },
    { label: 'Business segment', tables: ['2.1.10'] },
    { label: 'Package type', tables: ['2.1.11'] },
    { label: 'Cancellation penalty schedule', tables: ['2.1.13'] },
  ],
  perilPackage: { table: 'perils' },
  exclusionWaivers: null,
  supplemental: [
    {
      code: 'supplemental',
      name: 'Supplemental benefit',
      perHundred: '0.002',
      threshold: '1000',
      flat: '0.020',
      page: 'spec M2',
    },
  ],
  tables: [
    {
      id: '2.1.5',
      name: 'Trip cost per $100',
      page: 'spec M2 (2.1.5)',
      keys: [{ input: 'tripCost', match: 'band' }],
      rows: [{ keys: [4001], factor: '1.0000' }],
      unused: null,
      unknown: null,
    },
    {
      id: '2.1.4',
      name: 'Age by pre-existing waiver',
      page: 'spec M2 (2.1.4)',
      keys: [
        { input: 'age', match: 'band' },
        { input: 'preExistingWaived', match: 'exact' },
      ],
      rows: [
        { keys: [45, true], factor: '0.7200' },
        { keys: [45, false], factor: '0.6000' },
      ],
      unused: null,
      unknown: null,
    },
    {
      id: '2.1.7',
      name: 'Departure month',
      page: 'spec M2 (2.1.7)',
      keys: [{ input: 'departureMonth', match: 'exact' }],
      rows: [{ keys: [12], factor: '1.2880' }],
      unused: null,
      unknown: null,
    },
    {
      id: '2.1.8',
      name: 'Days before departure at purchase',
      page: 'spec M2 (2.1.8)',
      keys: [{ input: 'daysBeforeDeparture', match: 'band' }],
      rows: [
        { keys: [15], factor: '0.7680' },
        { keys: [451], factor: '1.2940' },
      ],
      unused: null,
      unknown: null,
    },
    {
      id: '2.1.9',
      name: 'Destination region',
      page: 'spec M2 (2.1.9)',
      keys: [{ input: 'destinationRegion', match: 'exact' }],
      rows: [{ keys: ['Europe'], factor: '1.0000' }],
      unused: null,
      unknown: null,
    },
    {
      id: '2.1.10',
      name: 'Business segment',
      page: 'spec M2 (2.1.10)',
      keys: [{ input: 'businessSegment', match: 'exact' }],
      rows: [
        { keys: ['Retail'], factor: '1.0000' },
        { keys: ['OTA - Cruise'], factor: '1.6286' },
      ],
      unused: null,
      unknown: null,
    },
    {
      id: '2.1.11',
      name: 'Package type',
      page: 'spec M2 (2.1.11)',
      keys: [{ input: 'packageType', match: 'exact' }],
      rows: [
        { keys: ['optional'], factor: '1.3333' },
        { keys: ['packaged'], factor: '1.0000' },
      ],
      unused: null,
      unknown: null,
    },
    {
      id: '2.1.13',
      name: 'Cancellation penalty schedule',
      page: 'spec M2 (2.1.13)',
      keys: [{ input: 'penaltyDays', match: 'band' }],
      rows: [{ keys: [60], factor: '1.28' }],
      unused: null,
      unknown: null,
    },
    {
      id: 'perils',
      name: 'Peril factors by coverage level',
      page: 'spec M2 (perils)',
      keys: [
        { input: 'peril', match: 'exact' },
        { input: 'coverageLevel', match: 'exact' },
      ],
      rows: [
        { keys: ['DEATH', 'self'], factor: '3.610' },
        { keys: ['DEATH', 'family_member'], factor: '2.704' },
        { keys: ['DEATH', 'travelling_companion'], factor: '0.403' },
      ],
      unused: null,
      unknown: null,
    },
  ],
  conversion: { lossCostMultiplier: null, minimumPremium: null, roundTo: 2 },
};

/** The specification's illustrative lookup: one traveller, the factors it lists (M2, "Illustrative factor lookup"). */
export const SPEC_ILLUSTRATIVE_REQUEST: RatingRequest = {
  state: 'DE',
  benefit: 'TCAN',
  rateDate: '2026-11-01',
  traveller: { age: 45, preExistingWaived: true },
  trip: {
    costPerTraveller: '4200',
    purchaseDate: '2026-11-21',
    departureDate: '2026-12-11',
    returnDate: '2026-12-20',
    destinations: [{ region: 'Europe', days: 10 }],
    penaltyDays: 60,
  },
  account: { businessSegment: 'OTA - Cruise', notCollected: [] },
  plan: { packageType: 'optional', perils: [], waivedExclusions: [], supplemental: [] },
};
