# ADR 0024: The model API key is set in the application

Status: accepted (requested November 2026). Stories: E15-F02-S02 (model gateway), E13-F02-S02 (secrets).

## Decisions

1. **A platform administrator saves the key on a settings screen** (Settings, AI model connection; permission
   `settings:manage`, held by platform administrators only). Agents and system clients cannot use these operations
   whatever they were granted.
2. **The key is stored encrypted** with the platform's envelope encryption (AES-256-GCM, bound to its record; the
   key-encryption key comes from Key Vault in Azure). It is never returned: screens and the audit trail show its last
   four characters.
3. **One key is in force.** Saving replaces it. A replaced or removed key is erased; who saved and removed it, when and
   why is kept.
4. **The saved key wins over the environment.** The worker reads it before each model call, so a change takes effect at
   once; with none saved it uses `ANTHROPIC_API_KEY` as before.
5. **Test connection** sends one very small request, shaped like an agent's, to each model the agents use, with either
   the key typed on the screen (not saved) or the saved one. It reports what failed in plain words. Results for the
   saved key are kept; every test is audited. Tests are rate limited.
6. The workbench's server function logging is off, so the key is not written to a development console.

## Not covered

- Claude through Microsoft Foundry: only the Anthropic API is supported.
- Spend limits are set per agent in the registry, not here.
