import { describe, expect, it } from 'vitest';
import { parseGroupRoleMap } from './authenticator';

describe('group to role mapping', () => {
  it('maps the default astra-<role> groups', () => {
    const map = parseGroupRoleMap(undefined);
    expect(map['astra-platform-admin']).toBe('platform_admin');
    expect(map['astra-partner-developer']).toBe('partner_developer');
  });

  it('accepts Entra ID group object IDs from configuration', () => {
    const map = parseGroupRoleMap('{"6f1c2b9e-0000-4000-8000-000000000001":"underwriter"}');
    expect(map['6f1c2b9e-0000-4000-8000-000000000001']).toBe('underwriter');
  });

  it('rejects unknown roles in configuration', () => {
    expect(() => parseGroupRoleMap('{"g":"superuser"}')).toThrow(/unknown role/);
  });
});
