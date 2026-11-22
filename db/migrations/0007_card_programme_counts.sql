-- Card programme counts for lists. Counting the ledger on every list request does not scale to large
-- programmes, so each programme keeps the number of accounts on file (current ledger periods) and of
-- certificates issued, recalculated when a feed is applied. "Eligible today" stays exact on the programme
-- page, served by the partial index below.

ALTER TABLE card.programmes
  ADD COLUMN accounts_on_file     integer NOT NULL DEFAULT 0,
  ADD COLUMN certificates_issued  integer NOT NULL DEFAULT 0;

UPDATE card.programmes p SET
  accounts_on_file = (SELECT count(*) FROM card.eligibility_periods e WHERE e.programme_id = p.id AND e.ended_by IS NULL),
  certificates_issued = (SELECT count(*) FROM card.certificates c WHERE c.programme_id = p.id);

CREATE INDEX eligibility_current_dates ON card.eligibility_periods (programme_id, valid_from, valid_to)
  WHERE ended_by IS NULL;
