/** API field names, as the person reads them on a form. */
const FIELD_LABELS: Record<string, string> = {
  accountId: 'Account',
  planCode: 'Plan',
  planVersionId: 'Plan version',
  state: 'State of sale',
  firstName: 'First name',
  lastName: 'Last name',
  dateOfBirth: 'Date of birth',
  age: 'Age',
  costPerTraveller: 'Trip cost',
  insuredPercent: 'Trip costs insured',
  departureDate: 'Departure',
  returnDate: 'Return',
  purchaseDate: 'Purchase date',
  initialDepositDate: 'Initial deposit date',
  destinations: 'Destination',
  businessSegment: 'Business segment',
};

/** "travellers.1.firstName" reads as "Traveller 2, first name". */
export function fieldLabel(path: string): string {
  const parts = path.split('.');
  const last = parts.at(-1)!;
  const field = FIELD_LABELS[last] ?? last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const person = parts.includes('travellers') ? parts[parts.indexOf('travellers') + 1] : undefined;
  const label =
    person !== undefined && /^\d+$/.test(person)
      ? `Traveller ${Number(person) + 1}, ${field.toLowerCase()}`
      : field;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
