# Increment 16e: Eligibility Feed agent (AG-09)

Design: [ADR 0021](../adr/0021-issuer-file-mapping-and-ag09.md). Everything in the tests is **synthetic**. The agent's
model is **scripted** (`ANTHROPIC_API_KEY` is not set), so AG-09 has never been run against Claude.

| Story E21-F04-S01 criterion | Status | Implementation and proof |
|---|---|---|
| The agent proposes a mapping and shows sample records | Met with a scripted model | Sample upload, preview, proposal with converted sample records; `card-mapping.int.test.ts`, `mapping.test.ts` |
| Rejected records are explained in plain language with a proposed fix | Met with a scripted model | One explanation and fix per rejection code, checked against the feed |
| I approve every mapping and fix | Met | Only a person with `card:manage`; no agent tool approves |

## To confirm with Assurant

- Issuers' real file layouts (only delimited text with a header line is read).
- Whether issuers will upload their own files with a mapping, or only the programme team.
