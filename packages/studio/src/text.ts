/** Page number (1-based) of a text offset, given the offsets where each page starts. */
export function pageOf(pageStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = pageStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pageStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The text location must match the form exactly, so a variable always points at real filed wording. */
export function checkLocation(
  text: string,
  start: number,
  end: number,
  excerpt: string,
): string | null {
  if (start < 0 || end > text.length || end <= start)
    return 'The location is outside the form text.';
  if (text.slice(start, end) !== excerpt)
    return 'The excerpt does not match the form text at that location.';
  return null;
}
