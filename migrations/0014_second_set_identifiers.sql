-- The application was renamed from MOKE to Second Set. Saved review metadata takes the new
-- instruction identifiers, so moke-packet-review-v10 reads second-set-packet-review-v10.
-- Provider attempts, tool results and SAM records stay byte for byte: they are the record of what
-- was sent and returned.
UPDATE review_execution_runs
SET prompt_version = 'second-set-' || substr(prompt_version, 6)
WHERE prompt_version LIKE 'moke-selected-coordination-v%';

UPDATE packet_reviews
SET payload = replace(replace(payload,
  '"moke-packet-review-v', '"second-set-packet-review-v'),
  '"moke-selected-coordination-v', '"second-set-selected-coordination-v')
WHERE payload LIKE '%"moke-packet-review-v%' OR payload LIKE '%"moke-selected-coordination-v%';

UPDATE review_records
SET payload = replace(replace(payload,
  '"moke-packet-review-v', '"second-set-packet-review-v'),
  '"moke-selected-coordination-v', '"second-set-selected-coordination-v')
WHERE payload LIKE '%"moke-packet-review-v%' OR payload LIKE '%"moke-selected-coordination-v%';

UPDATE review_commands
SET receipt = replace(replace(receipt,
  '"moke-packet-review-v', '"second-set-packet-review-v'),
  '"moke-selected-coordination-v', '"second-set-selected-coordination-v')
WHERE receipt LIKE '%"moke-packet-review-v%' OR receipt LIKE '%"moke-selected-coordination-v%';

UPDATE review_execution_commands
SET response_json = replace(replace(response_json,
  '"moke-packet-review-v', '"second-set-packet-review-v'),
  '"moke-selected-coordination-v', '"second-set-selected-coordination-v')
WHERE response_json LIKE '%"moke-packet-review-v%'
  OR response_json LIKE '%"moke-selected-coordination-v%';

UPDATE review_events
SET message = 'Second Set review response saved.'
WHERE message = 'MOKE review response saved.';
