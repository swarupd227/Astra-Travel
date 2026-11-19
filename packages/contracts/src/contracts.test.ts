import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  EVENT_CATALOGUE,
  EventEnvelopeSchema,
  permissionsFor,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
} from './index';

describe('role permissions', () => {
  it('lets every staff role sign in to the workbench, and no partner', () => {
    for (const role of STAFF_ROLES) expect(ROLE_PERMISSIONS[role]).toContain('workbench:access');
    expect(ROLE_PERMISSIONS.partner_developer).not.toContain('workbench:access');
  });

  it('gives partners no platform-wide permissions', () => {
    for (const p of [
      'events:read',
      'events:replay',
      'audit:read',
      'audit:verify',
      'flags:manage',
      'accounts:manage',
    ] as const) {
      expect(ROLE_PERMISSIONS.partner_developer).not.toContain(p);
    }
  });

  it('gives platform administrators every permission and unions multiple roles', () => {
    expect(permissionsFor(['platform_admin'])).toEqual(ALL_PERMISSIONS);
    const combined = permissionsFor(['compliance_officer', 'ops_supervisor']);
    expect(combined).toContain('audit:verify');
    expect(combined).toContain('events:replay');
  });
});

describe('event envelope', () => {
  const valid = {
    id: '7d1f6c2a-3b4e-4f5a-8b6c-9d0e1f2a3b01',
    type: 'PolicyBound',
    version: 1,
    time: '2026-11-19T10:00:00.000Z',
    source: 'astra.policy.issue',
    correlationId: 'corr-1',
    accountId: null,
    state: 'DE',
    data: {},
  };

  it('accepts the standard envelope', () => {
    expect(EventEnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it('rejects malformed type, source, state and version', () => {
    for (const bad of [
      { type: 'policy.bound' },
      { source: 'policy' },
      { state: 'Delaware' },
      { version: 0 },
    ]) {
      expect(EventEnvelopeSchema.safeParse({ ...valid, ...bad }).success).toBe(false);
    }
  });

  it('has a unique, valid definition for every catalogued event', () => {
    const types = EVENT_CATALOGUE.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
    for (const e of EVENT_CATALOGUE) {
      expect(EventEnvelopeSchema.shape.type.safeParse(e.type).success).toBe(true);
      expect(EventEnvelopeSchema.shape.source.safeParse(e.source).success).toBe(true);
    }
  });
});
