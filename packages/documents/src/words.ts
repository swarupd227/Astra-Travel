/** Numbers in the formats filed forms use: "ten (10)", "one hundred sixty-eight (168)", "$500,000". */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A whole number in words, as forms write it: "twenty-four", "one hundred sixty-eight", "one thousand five hundred". */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) throw new RangeError(`${n} cannot be written in words`);
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
}

/** "ten (10)": the form's way of stating a period or count. */
export const wordsAndFigures = (n: number): string => `${numberToWords(n)} (${n})`;

export function dollars(n: number): string {
  const [whole, frac] = n.toFixed(2).split('.');
  return `$${Number(whole).toLocaleString('en-US')}${frac === '00' ? '' : `.${frac}`}`;
}

export const withCommas = (n: number): string => n.toLocaleString('en-US');
