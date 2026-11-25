import { randomUUID } from 'node:crypto';

/**
 * A per-process key marking the API's own calls to itself (booking files make a quote and a bind for every booking
 * through the real routes). Such calls skip the rate limit that protects the API from outside callers; they are
 * authenticated and authorised like any other. The key never leaves the process.
 */
export const INTERNAL_HEADER = 'x-astra-internal';
export const INTERNAL_KEY = randomUUID();
