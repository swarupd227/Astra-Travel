/**
 * Content of the sample data set: Assurant's travel business as the product specification describes it (Project
 * Voyager retail travel on Virginia Surety Company paper sold through travel sellers, and card-linked cover for card
 * issuers and banks), with INVENTED partners, people, rates and wording. Nothing here is a filed form, a filed rate,
 * a real account or a real person.
 */

export const SAMPLE = 'sample';
export const SYNTHETIC_SOURCE = 'SYNTHETIC sample data (not filed, not from Assurant)';

export const US_STATES: [string, string, 'state' | 'district'][] = (
  'AL Alabama,AK Alaska,AZ Arizona,AR Arkansas,CA California,CO Colorado,CT Connecticut,DE Delaware,' +
  'FL Florida,GA Georgia,HI Hawaii,ID Idaho,IL Illinois,IN Indiana,IA Iowa,KS Kansas,KY Kentucky,LA Louisiana,' +
  'ME Maine,MD Maryland,MA Massachusetts,MI Michigan,MN Minnesota,MS Mississippi,MO Missouri,MT Montana,' +
  'NE Nebraska,NV Nevada,NH New Hampshire,NJ New Jersey,NM New Mexico,NY New York,NC North Carolina,' +
  'ND North Dakota,OH Ohio,OK Oklahoma,OR Oregon,PA Pennsylvania,RI Rhode Island,SC South Carolina,' +
  'SD South Dakota,TN Tennessee,TX Texas,UT Utah,VT Vermont,VA Virginia,WA Washington,WV West Virginia,' +
  'WI Wisconsin,WY Wyoming'
)
  .split(',')
  .map((s): [string, string, 'state' | 'district'] => [s.slice(0, 2), s.slice(3), 'state'])
  .concat([['DC', 'District of Columbia', 'district']]);

/** The states the sample plans are sold in, with a factor applied to the invented base loss costs. */
export const SALE_STATES: [string, number][] = [
  ['DE', 1.0],
  ['FL', 1.18],
  ['TX', 1.07],
  ['CA', 1.14],
  ['NY', 1.21],
  ['IL', 0.97],
  ['PA', 0.94],
  ['GA', 1.02],
];

/** ISO 3166-1 codes of the destinations used. */
export const COUNTRIES: [string, string, string, string][] = (
  'US USA 840 United States|CA CAN 124 Canada|MX MEX 484 Mexico|BS BHS 044 Bahamas|JM JAM 388 Jamaica|' +
  'DO DOM 214 Dominican Republic|BB BRB 052 Barbados|AW ABW 533 Aruba|CR CRI 188 Costa Rica|PA PAN 591 Panama|' +
  'BR BRA 076 Brazil|AR ARG 032 Argentina|PE PER 604 Peru|CL CHL 152 Chile|CO COL 170 Colombia|' +
  'GB GBR 826 United Kingdom|IE IRL 372 Ireland|FR FRA 250 France|DE DEU 276 Germany|IT ITA 380 Italy|' +
  'ES ESP 724 Spain|PT PRT 620 Portugal|GR GRC 300 Greece|NL NLD 528 Netherlands|CH CHE 756 Switzerland|' +
  'AT AUT 040 Austria|IS ISL 352 Iceland|NO NOR 578 Norway|SE SWE 752 Sweden|JP JPN 392 Japan|' +
  'CN CHN 156 China|IN IND 356 India|TH THA 764 Thailand|SG SGP 702 Singapore|VN VNM 704 Viet Nam|' +
  'AU AUS 036 Australia|NZ NZL 554 New Zealand|FJ FJI 242 Fiji|AE ARE 784 United Arab Emirates|' +
  'ZA ZAF 710 South Africa|KE KEN 404 Kenya|TZ TZA 834 Tanzania|EG EGY 818 Egypt|MA MAR 504 Morocco|' +
  'AQ ATA 010 Antarctica|CU CUB 192 Cuba|IR IRN 364 Iran|KP PRK 408 North Korea|SY SYR 760 Syrian Arab Republic'
)
  .split('|')
  .map((s) => {
    const [a2, a3, num, ...name] = s.split(' ');
    return [a2!, a3!, num!, name.join(' ')];
  });

export const PROHIBITED = ['CU', 'IR', 'KP', 'SY'];

export const REGIONS = [
  { code: 'DOMESTIC', name: 'United States', scope: 'domestic', countries: ['US'] },
  {
    code: 'NORTH_AMERICA',
    name: 'Canada and Mexico',
    scope: 'international',
    countries: ['CA', 'MX'],
  },
  {
    code: 'CARIBBEAN',
    name: 'Caribbean and Central America',
    scope: 'international',
    countries: ['BS', 'JM', 'DO', 'BB', 'AW', 'CR', 'PA'],
  },
  {
    code: 'SOUTH_AMERICA',
    name: 'South America',
    scope: 'international',
    countries: ['BR', 'AR', 'PE', 'CL', 'CO'],
  },
  {
    code: 'EUROPE',
    name: 'Europe',
    scope: 'international',
    countries: ['GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'GR', 'NL', 'CH', 'AT', 'IS', 'NO', 'SE'],
  },
  {
    code: 'ASIA_PACIFIC',
    name: 'Asia and Pacific',
    scope: 'international',
    countries: ['JP', 'CN', 'IN', 'TH', 'SG', 'VN', 'AU', 'NZ', 'FJ'],
  },
  {
    code: 'AFRICA_MIDEAST',
    name: 'Africa and Middle East',
    scope: 'international',
    countries: ['AE', 'ZA', 'KE', 'TZ', 'EG', 'MA'],
  },
  { code: 'ANTARCTICA', name: 'Antarctica', scope: 'international', countries: ['AQ'] },
];

/** Destinations drawn for sample trips, with their rating region name and a relative weight. */
export const TRIP_DESTINATIONS: [string, string, number][] = [
  ['US', 'United States', 14],
  ['MX', 'Canada and Mexico', 12],
  ['CA', 'Canada and Mexico', 5],
  ['BS', 'Caribbean and Central America', 8],
  ['JM', 'Caribbean and Central America', 6],
  ['DO', 'Caribbean and Central America', 6],
  ['CR', 'Caribbean and Central America', 4],
  ['GB', 'Europe', 8],
  ['IT', 'Europe', 8],
  ['FR', 'Europe', 7],
  ['ES', 'Europe', 5],
  ['GR', 'Europe', 4],
  ['IS', 'Europe', 2],
  ['JP', 'Asia and Pacific', 4],
  ['TH', 'Asia and Pacific', 2],
  ['AU', 'Asia and Pacific', 2],
  ['PE', 'South America', 2],
  ['ZA', 'Africa and Middle East', 1],
  ['AE', 'Africa and Middle East', 1],
];

/** Business segments: those the specification lists for retail distribution. */
export const SEGMENTS: [string, string][] = [
  ['RETAIL', 'Retail'],
  ['RETAIL_LUXURY', 'Retail luxury'],
  ['AIR_DOMESTIC', 'Domestic air'],
  ['AIR_INTERNATIONAL', 'International air'],
  ['AIR_COMPREHENSIVE', 'Comprehensive air'],
  ['CRUISE_OCEAN', 'Cruise, ocean'],
  ['CRUISE_RIVER', 'Cruise, river'],
  ['OTA_TOUR', 'Online travel agency, tour'],
  ['OTA_AIR', 'Online travel agency, air'],
  ['OTA_CRUISE', 'Online travel agency, cruise'],
  ['TOUR_GENERAL', 'General tour'],
  ['GROUP', 'Group'],
  ['WHOLESALE', 'Wholesale'],
  ['PROPERTY_MGMT', 'Property management'],
  ['TIMESHARE', 'Timeshare'],
  ['STUDENT', 'Student'],
];

export interface SampleAccount {
  code: string;
  name: string;
  kind: 'travel_account' | 'bank' | 'card_issuer';
  segment: string;
  integration: 'api' | 'files' | 'mulesoft' | 'widget';
  /** Relative share of policy sales. */
  weight: number;
  states: number;
}

const seller = (
  code: string,
  name: string,
  segment: string,
  integration: SampleAccount['integration'],
  weight: number,
  states = 8,
): SampleAccount => ({
  code,
  name: `${name} (${SAMPLE})`,
  kind: 'travel_account',
  segment,
  integration,
  weight,
  states,
});

export const SELLERS: SampleAccount[] = [
  seller('BLUEHERON-AIR', 'Blue Heron Airlines', 'AIR_COMPREHENSIVE', 'api', 14),
  seller('CASCADIA-AIR', 'Cascadia Air', 'AIR_DOMESTIC', 'api', 9),
  seller('MERIDIAN-INTL', 'Meridian International Airways', 'AIR_INTERNATIONAL', 'mulesoft', 7),
  seller('SUNPORT-AIR', 'Sunport Regional Air', 'AIR_DOMESTIC', 'widget', 3, 4),
  seller('TIDEWATER-CRUISE', 'Tidewater Cruise Lines', 'CRUISE_OCEAN', 'files', 10),
  seller('RIVERBEND-CRUISE', 'Riverbend River Cruises', 'CRUISE_RIVER', 'files', 5),
  seller('AURORA-EXPEDITION', 'Aurora Expedition Voyages', 'CRUISE_OCEAN', 'api', 3, 5),
  seller('WAYFINDER-OTA', 'Wayfinder Travel Online', 'OTA_AIR', 'api', 12),
  seller('TRIPNEST-OTA', 'TripNest', 'OTA_TOUR', 'widget', 8),
  seller('HARBORLIGHT-OTA', 'Harborlight Cruise Deals', 'OTA_CRUISE', 'widget', 4),
  seller('SUMMIT-TOURS', 'Summit & Vale Tours', 'TOUR_GENERAL', 'files', 6),
  seller('OLDWORLD-JOURNEYS', 'Old World Journeys', 'TOUR_GENERAL', 'mulesoft', 4, 5),
  seller('GATHERWELL-GROUPS', 'Gatherwell Group Travel', 'GROUP', 'files', 4, 4),
  seller('ATLAS-WHOLESALE', 'Atlas Wholesale Travel', 'WHOLESALE', 'files', 3),
  seller('PALMKEY-RENTALS', 'Palm Key Vacation Rentals', 'PROPERTY_MGMT', 'api', 5, 3),
  seller('PINERIDGE-STAYS', 'Pine Ridge Stays', 'PROPERTY_MGMT', 'widget', 2, 3),
  seller('SEAGLASS-CLUB', 'Seaglass Vacation Club', 'TIMESHARE', 'mulesoft', 3, 4),
  seller('CAMPUSROUTE', 'CampusRoute Student Travel', 'STUDENT', 'widget', 2, 5),
  seller('LANTERN-LUXE', 'Lantern Private Travel', 'RETAIL_LUXURY', 'api', 3, 5),
  seller('COMPASS-RETAIL', 'Compass Travel Stores', 'RETAIL', 'api', 4),
  seller('MAINSTREET-TRAVEL', 'Main Street Travel Agents', 'RETAIL', 'files', 3, 4),
];

export const ISSUERS: {
  code: string;
  name: string;
  kind: 'card_issuer' | 'bank';
  products: [string, string, string][];
}[] = [
  {
    code: 'NORTHSTAR-CARD',
    name: `Northstar Card Services (${SAMPLE})`,
    kind: 'card_issuer',
    products: [
      ['NS-SUMMIT', 'Northstar Summit travel protection', 'Summit Reserve'],
      ['NS-EVERYDAY', 'Northstar Everyday trip delay cover', 'Everyday Rewards'],
    ],
  },
  {
    code: 'GRANITE-BANK',
    name: `Granite Federal Bank (${SAMPLE})`,
    kind: 'bank',
    products: [['GR-PLATINUM', 'Granite Platinum travel cover', 'Platinum']],
  },
  {
    code: 'LAKESHORE-CU',
    name: `Lakeshore Credit Union (${SAMPLE})`,
    kind: 'bank',
    products: [['LS-VOYAGE', 'Lakeshore Voyage cover', 'Voyage Visa']],
  },
  {
    code: 'COPPERLINE-CARD',
    name: `Copperline Financial (${SAMPLE})`,
    kind: 'card_issuer',
    products: [['CL-TRAVELER', 'Copperline Traveler protection', 'Traveler Elite']],
  },
];

export const FIRST_NAMES = (
  'Ava Ben Carla Diego Elena Farid Grace Hana Ivan Jade Kofi Lena Marco Nadia Omar Priya Quinn Rosa Sam Tara ' +
  'Umar Vera Wes Ximena Yusuf Zoe Aaron Bianca Caleb Dina Evan Fatima Gil Helen Isaac June Kai Leila Miles Nora ' +
  'Owen Paula Rafael Sana Theo Uma Victor Willa Yara Zane Amara Bruno Celia Dev Esme Felix Gwen Hugo Iris Joel'
).split(' ');
export const LAST_NAMES = (
  'Abbott Barrera Chen Dalton Eze Ferreira Gupta Hollis Ibrahim Jensen Kowalski Lindqvist Moreau Nakamura Okafor ' +
  'Petrova Quintero Rahman Silva Tanaka Underwood Vasquez Whitfield Xu Yilmaz Zamora Ashford Bellamy Crowe ' +
  'Delgado Ellery Fontaine Garrity Hale Ingram Joyner Keller Lowell Marchetti Nolan Osei Pruitt Ramsey Sorensen ' +
  'Thackeray Ulrich Vance Winslow York Zielinski'
).split(' ');

/** The synthetic person on the synthetic sanctions list: quoting them raises a sanctions hold. */
export const SANCTIONED = {
  firstName: 'Zorbek',
  lastName: 'Testburg',
  dateOfBirth: '1970-03-12',
  sdn: '9001,"TESTBURG, Zorbek",individual,SYNTH,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 12 Mar 1970"\n9002,"EXAMPLESKI, Ruvan Dalo",individual,SYNTH,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 03 Jul 1982"',
};

export const NOTICE =
  'The traveller confirms they are medically able to travel and are not under restricting treatment.';

export interface SampleBenefit {
  code: string;
  name: string;
  group: 'pre_departure' | 'post_departure';
  key: string;
  bracket: string;
  basis: 'per_person';
  /** The invented base loss cost per $100 of trip cost where the benefit is priced. */
  rating?: { code: string; base: number };
  /** Every benefit of the filed schedule is in both plans; the essential plan offers some only as options. */
  essential: { value: number; packaging: 'packaged' | 'standalone_optional' };
  preferred: { value: number; packaging: 'packaged' | 'standalone_optional' };
  underwriter: 'VSC' | 'ABIC';
}

export const BENEFITS: SampleBenefit[] = [
  {
    code: 'trip_cancellation',
    name: 'Trip Cancellation',
    group: 'pre_departure',
    key: 'tc_max',
    bracket: '[$500-$50,000]',
    basis: 'per_person',
    rating: { code: 'TCAN', base: 3.2 },
    essential: { value: 10000, packaging: 'packaged' },
    preferred: { value: 30000, packaging: 'packaged' },
    underwriter: 'VSC',
  },
  {
    code: 'trip_interruption',
    name: 'Trip Interruption',
    group: 'post_departure',
    key: 'ti_max',
    bracket: '[$500-$75,000]',
    basis: 'per_person',
    rating: { code: 'TINT', base: 0.9 },
    essential: { value: 15000, packaging: 'standalone_optional' },
    preferred: { value: 45000, packaging: 'packaged' },
    underwriter: 'VSC',
  },
  {
    code: 'trip_delay',
    name: 'Trip Delay',
    group: 'post_departure',
    key: 'delay_max',
    bracket: '[$100-$3,000]',
    basis: 'per_person',
    essential: { value: 500, packaging: 'packaged' },
    preferred: { value: 2000, packaging: 'packaged' },
    underwriter: 'VSC',
  },
  {
    code: 'missed_connection',
    name: 'Missed Connection',
    group: 'post_departure',
    key: 'missed_max',
    bracket: '[$100-$2,500]',
    basis: 'per_person',
    essential: { value: 250, packaging: 'standalone_optional' },
    preferred: { value: 1000, packaging: 'packaged' },
    underwriter: 'VSC',
  },
  {
    code: 'baggage_loss',
    name: 'Baggage and Personal Effects',
    group: 'post_departure',
    key: 'baggage_max',
    bracket: '[$250-$3,000]',
    basis: 'per_person',
    rating: { code: 'BAGG', base: 0.25 },
    essential: { value: 750, packaging: 'standalone_optional' },
    preferred: { value: 2000, packaging: 'standalone_optional' },
    underwriter: 'ABIC',
  },
  {
    code: 'baggage_delay',
    name: 'Baggage Delay',
    group: 'post_departure',
    key: 'bagdelay_max',
    bracket: '[$100-$600]',
    basis: 'per_person',
    essential: { value: 150, packaging: 'standalone_optional' },
    preferred: { value: 300, packaging: 'packaged' },
    underwriter: 'ABIC',
  },
  {
    code: 'emergency_medical',
    name: 'Emergency Accident and Sickness Medical Expense',
    group: 'post_departure',
    key: 'medical_max',
    bracket: '[$10,000-$250,000]',
    basis: 'per_person',
    rating: { code: 'MEDE', base: 0.6 },
    essential: { value: 25000, packaging: 'standalone_optional' },
    preferred: { value: 100000, packaging: 'standalone_optional' },
    underwriter: 'ABIC',
  },
  {
    code: 'medical_evacuation',
    name: 'Emergency Evacuation and Repatriation',
    group: 'post_departure',
    key: 'evac_max',
    bracket: '[$50,000-$1,000,000]',
    basis: 'per_person',
    essential: { value: 100000, packaging: 'standalone_optional' },
    preferred: { value: 500000, packaging: 'packaged' },
    underwriter: 'ABIC',
  },
];

/** Age bands of the invented manuals: lower bound and factor. Age 45 is 1.00. */
export const AGE_FACTORS: [number, number][] = [
  [0, 0.55],
  [18, 0.72],
  [36, 1.0],
  [51, 1.32],
  [61, 1.74],
  [71, 2.35],
  [81, 3.1],
];
/** Trip length bands (days): lower bound and factor. Up to 14 days is 1.00. */
export const LENGTH_FACTORS: [number, number][] = [
  [0, 1.0],
  [15, 1.08],
  [31, 1.19],
  [61, 1.35],
  [91, 1.55],
];
