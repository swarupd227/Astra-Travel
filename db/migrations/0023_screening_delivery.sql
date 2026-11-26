-- Increment 16d: screening at change and refund, and delivery receipts (E14-F03-S02, E14-F03-S03). Design: docs/adr/0020.

ALTER TABLE underwriting.referrals DROP CONSTRAINT referrals_stage_check;
ALTER TABLE underwriting.referrals ADD CONSTRAINT referrals_stage_check CHECK (stage IN ('quote', 'bind', 'change', 'refund'));

-- What the delivery provider reports after a message left: it arrived, or it came back.
ALTER TABLE documents.deliveries ADD COLUMN receipt text NULL CHECK (receipt IN ('delivered', 'bounced'));
ALTER TABLE documents.deliveries ADD COLUMN receipt_at timestamptz NULL;
ALTER TABLE documents.deliveries ADD COLUMN receipt_detail text NULL CHECK (receipt_detail IS NULL OR char_length(receipt_detail) <= 500);
