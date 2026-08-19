-- Operation 35 labels: hyphen -> em dash (2026-08-13, Jac).
--
-- 2026-08-07-operation-35-tags.sql shipped these with a hyphen separator
-- ("Operation 35 - LT") because that is how they were requested. Every other
-- multi-word label in the catalog uses an em dash ("Alumni — Cohort 1"), and
-- the label is what the Tags picker and the Tags filter render, so the
-- inconsistency is visible to the whole team. This aligns them.
--
-- LABEL ONLY. Slugs are untouched — they are the stored value in
-- public.contacts.tags and the key every downstream rule matches on
-- (_PURSUIT_UNIVERSE, the jobs-prospect recuration, the campaign rollups), so
-- renaming one would orphan every contact carrying it. sort_order and active
-- are untouched too: priority order is drag-editable in the UI
-- (PUT /api/jobs/tag-campaigns/order) and a migration shouldn't undo a hand-set
-- order.
--
-- No deploy needed. GET /api/jobs/contact-tags reads the catalog per request,
-- so the new labels appear on the next page load.
--
-- Idempotent: the WHERE clause skips rows that already match, so a re-run is a
-- no-op rather than a rewrite.

BEGIN;

UPDATE bedrock.contact_tag_catalog AS c
   SET label = v.label
  FROM (VALUES
    ('operation_35_lt',      'Operation 35 — LT'),
    ('operation_35_lt_nick', 'Operation 35 — LT_Nick'),
    ('operation_35_staff',   'Operation 35 — Staff'),
    ('operation_35_pursuit', 'Operation 35 — Pursuit'),
    ('operation_35_other',   'Operation 35 — Other')
  ) AS v(slug, label)
 WHERE c.slug = v.slug
   AND c.label IS DISTINCT FROM v.label;

COMMIT;

-- Verify:
--   SELECT slug, label FROM bedrock.contact_tag_catalog
--    WHERE slug LIKE 'operation_35%' ORDER BY sort_order;
--   -- expect five labels reading "Operation 35 — …" with an em dash (U+2014)
