import type { Principal } from './context';
import type { Logger } from './logger';
import type { Pool } from './db';

/**
 * Display names for recorded subjects. The API records the signed-in principal's name (from its token)
 * at most once per interval per subject, so screens can show who did something by name.
 */
export class PeopleDirectory {
  private readonly seen = new Map<string, { name: string | null; at: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    private readonly intervalMs = 15 * 60_000,
  ) {}

  async record(p: Principal): Promise<void> {
    const last = this.seen.get(p.subject);
    if (last && last.name === p.name && Date.now() - last.at < this.intervalMs) return;
    this.seen.set(p.subject, { name: p.name, at: Date.now() });
    try {
      await this.pool.query(
        `INSERT INTO platform.people (subject, name, kind) VALUES ($1, $2, $3)
         ON CONFLICT (subject) DO UPDATE SET name = coalesce(EXCLUDED.name, people.name), kind = EXCLUDED.kind, last_seen = now()`,
        [p.subject, p.name?.slice(0, 200) || null, p.kind],
      );
    } catch (err) {
      // Never fail a request over a display name.
      this.seen.delete(p.subject);
      this.logger.warn({ err }, 'Could not record the display name');
    }
  }
}

export interface PersonName {
  subject: string;
  name: string;
  kind: 'user' | 'partner' | 'system' | 'agent' | 'unknown';
}

/** Names for subjects; platform components recorded as `system:<component>` are named after the component. */
export async function namesFor(pool: Pool, subjects: string[]): Promise<PersonName[]> {
  const unique = [...new Set(subjects)].filter(Boolean).slice(0, 200);
  if (!unique.length) return [];
  const { rows } = await pool.query<{
    subject: string;
    name: string | null;
    kind: PersonName['kind'];
  }>(`SELECT subject, name, kind FROM platform.people WHERE subject = ANY ($1::text[])`, [unique]);
  const found = new Map(rows.map((r) => [r.subject, r]));
  return unique.map((s) => {
    const r = found.get(s);
    if (r?.name) return { subject: s, name: r.name, kind: r.kind };
    if (s.startsWith('system:'))
      return { subject: s, name: `System (${s.slice(7)})`, kind: 'system' };
    return {
      subject: s,
      name: r ? `Unnamed ${r.kind}` : 'Unknown person',
      kind: r?.kind ?? 'unknown',
    };
  });
}
