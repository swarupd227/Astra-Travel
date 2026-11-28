/**
 * Validation messages from the API's schema checks, in words for the person filling the form.
 * Messages the platform writes itself are shown as they are.
 */
const RULES: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^Too small: expected string to have >=1 characters$/, () => 'Required.'],
  [
    /^Too small: expected string to have >=(\d+) characters$/,
    (m) => `Use at least ${m[1]} characters.`,
  ],
  [
    /^Too big: expected string to have <=(\d+) characters$/,
    (m) => `Use at most ${m[1]} characters.`,
  ],
  [
    /^Too small: expected (?:number|int) to be >=?\s*(-?[\d.]+)$/,
    (m) => `Must be at least ${m[1]}.`,
  ],
  [/^Too big: expected (?:number|int) to be <=?\s*(-?[\d.]+)$/, (m) => `Must be at most ${m[1]}.`],
  [/^Too small: expected array to have >=1 items$/, () => 'Add at least one.'],
  [/^Invalid ISO (?:date|datetime)$/, () => 'Enter a date.'],
  [/^Invalid email address$/, () => 'Enter an email address.'],
  [/^Invalid URL$/, () => 'Enter a web address.'],
  [/^Invalid (?:UUID|GUID)$/, () => 'Choose one.'],
  [/^Invalid option: expected one of .*$/, () => 'Choose one of the options.'],
  [/^Invalid input: expected number, received .*$/, () => 'Enter a number.'],
  [/^Invalid input: expected int, received .*$/, () => 'Enter a whole number.'],
  [/^Invalid input: expected \w+, received undefined$/, () => 'Required.'],
  [/^Invalid string: must match pattern .*$/, () => 'Check the format.'],
  [/^The request is not valid$/, () => 'Some details need attention.'],
];

export function plainMessage(message: string): string {
  for (const [pattern, words] of RULES) {
    const match = pattern.exec(message);
    if (match) return words(match);
  }
  return message;
}

/** Removes server setting names, such as "(SMTP_URL)", from a message the platform recorded. */
export function plainReason(message: string): string {
  return message.replace(/\s*\([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\)/g, '');
}
