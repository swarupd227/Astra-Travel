import { api, getMe } from './api';

/**
 * Display names for the subjects a page shows (who loaded, approved, received...), fetched in one request.
 * The signed-in user is marked "(you)". If names cannot be loaded, the subject itself is shown.
 */
export async function peopleNames(
  subjects: (string | null | undefined)[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(subjects.filter((s): s is string => !!s))];
  if (!wanted.length) return {};
  const names: Record<string, string> = {};
  try {
    const query = wanted.map((s) => `subject=${encodeURIComponent(s)}`).join('&');
    const { items } = await api<{ items: { subject: string; name: string }[] }>(
      `/v1/people?${query}`,
    );
    for (const p of items) names[p.subject] = p.name;
  } catch {
    for (const s of wanted) names[s] = s;
  }
  const me = await getMe();
  if (me && names[me.subject]) names[me.subject] = `${names[me.subject]} (you)`;
  return names;
}

/** The name for a subject, or a dash when there is none. */
export const nameOf = (names: Record<string, string>, subject: string | null | undefined) =>
  subject ? (names[subject] ?? subject) : '—';
