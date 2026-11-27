# Sample data

A data set for trying and demonstrating the platform, built around Assurant's travel business as the specification
describes it. **Everything in it is invented.** It is not Assurant's data, nothing in it is a filed form or rate, and
it must never sit beside real business.

## What it holds

| Area | Content |
|---|---|
| Product | Voyager Essential and Voyager Preferred, each with state plans for DE, FL, TX, CA, NY, IL, PA and GA, on one synthetic schedule of eight benefits |
| Underwriting paper | Virginia Surety Company and American Bankers Insurance Company of Florida, as arrangements named by the specification |
| Rates | 32 synthetic rate manuals (cancellation, interruption, baggage, medical), with check cases and approved sample filings |
| Rules | Age and trip length limits, a high trip cost referral, duplicate cover, a synthetic sanctions list |
| Accounts | 21 invented travel sellers across the retail segments (two still onboarding), 4 invented card issuers and banks |
| Business | About 3,000 policies with purchase dates over five months, open quotes, cancellations and changes, referrals (some waiting), premium records and billing batches |
| Card-linked cover | 5 programmes with eligibility feeds of invented card tokens, and cover checks |

Every account, person and loader user is named as sample data. Rate manuals and reference data carry the source
"SYNTHETIC sample data".

Limits: all policies were made on the day of loading (only their purchase dates are spread), no trip is in the past,
and nothing was run by an AI agent.

## Loading it

In Azure (development only):

```powershell
./infra/azure/load-sample-data.ps1 -Subscription '<subscription name or id>'
```

The loader (`apps/api/src/demo`) runs the platform's API inside a job, so every record passes the same permissions,
second-person approvals and database rules as in use. It runs only with `ASTRA_SAMPLE_DATA=load`, refuses a database
holding policies of accounts that are not sample accounts, adds and never deletes, and carries on where it stopped.

There is no command that removes the data. To start again, recreate the environment's `astra` database; this also
removes the saved model API key.
