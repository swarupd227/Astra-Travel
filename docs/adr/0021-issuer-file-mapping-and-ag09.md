# ADR 0021: Issuer file mappings and the Eligibility Feed agent

Status: accepted (Increment 16e). Story: E21-F04-S01.

## Decisions

1. **A mapping converts into the one feed format.** An issuer's delimited file is turned into eligibility feed v1 and
   processed by the same parser, control totals, reject threshold and ledger as any feed. Rejections carry the line
   numbers of the issuer's own file. A value that cannot be converted is passed through so the parser rejects it with
   its reason; nothing is guessed.
2. **A mapping is declarative**: delimiter, the column for each field, translations of product and action values, and
   a named date format. No expressions or code.
3. **Card numbers never settle.** A sample keeps only the first 200 lines, with card numbers replaced before storing
   (the agent therefore never sees one). In conversion a card number is replaced by the standard test number, so the
   record is still rejected as a card number and the real one is not written.
4. **A person approves every version and every fix** (`card:manage`, users only). Approval checks the mapping against
   a sample. Versions are immutable; approving supersedes the last. Approving the agent's proposal records whether it
   was changed first. Explanations are decided one by one, all of them; only one mapping change can be approved at a
   time.
5. **AG-09 runs at L1** with read tools, a preview and two propose tools. The platform refuses a mapping that lacks a
   column or converts nothing, and an explanation of a code the feed did not use.

## Not decided

- Fixed-width, spreadsheet or XML issuer formats: only delimited text is read.
- Files without a header line, and multi-line quoted fields.
- Converting very large files has not been load tested; it streams line by line like the feed parser.
