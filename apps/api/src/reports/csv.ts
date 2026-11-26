/**
 * CSV for downloads. A cell that a spreadsheet would read as a formula (starting with =, +, @, a tab or a carriage
 * return, or with a minus sign that is not a number) is prefixed with an apostrophe, so a name typed by someone
 * outside cannot run when the file is opened.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+@\t\r]/.test(s) || (s.startsWith('-') && !/^-\d+(\.\d+)?$/.test(s) && s !== '--')) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
