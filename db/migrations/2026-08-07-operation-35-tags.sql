-- Operation 35 tags (2026-08-07, requested by Kwame): five new entries in the
-- curated contact-tag vocabulary, alongside the existing alumni / hiring-partner
-- / volunteer / board tags.
--
--   operation_35_lt        Operation 35 - LT
--   operation_35_lt_nick   Operation 35 - LT_Nick
--   operation_35_staff     Operation 35 - Staff
--   operation_35_pursuit   Operation 35 - Pursuit
--   operation_35_other     Operation 35 - Other
--
-- WHY A MIGRATION and not a UI action: bedrock.contact_tag_catalog is the single
-- source of the tag vocabulary — the picker on the jobs Contacts page reads it,
-- and PATCH /api/jobs/contacts/{id} rejects any slug that is not an active row
-- in it (routes/jobs.py, "Unknown tags (not in catalog)"). There is no endpoint
-- that inserts a catalog row, and the *_dev roles hold SELECT only on the table,
-- so a new tag can only enter the vocabulary here.
--
-- VOCABULARY ONLY — this file tags no contacts. Adding catalog rows is inert
-- until somebody applies a tag, which matters because a curated tag is load-
-- bearing in two places once it lands on a contact:
--   1. My Network → Pursuit scope (_PURSUIT_UNIVERSE in routes/jobs.py) admits
--      any contact carrying a curated tag that is not alumni_* and not
--      'influence' — so Operation 35 contacts will appear there.
--   2. The jobs-prospect recuration rule (2026-07-28-recurate-jobs-prospects-
--      cleanup.sql) keeps any contact carrying a curated tag.
-- Both are the intended behaviour for a real campaign tag; noting them so the
-- effect is a decision rather than a surprise.
--
-- sort_order 130-134 places these below the existing tags (current max is 120).
-- It is the campaign priority on Performance → tag campaigns and is drag-
-- reorderable in the UI (PUT /api/jobs/tag-campaigns/order), as is the campaign
-- owner (PUT /api/jobs/tag-campaigns/owner) — neither needs a migration, which
-- is why ON CONFLICT deliberately does NOT reset sort_order: re-running this
-- file must not undo a priority order the team has since set by hand.
--
-- Idempotent. Safe to run more than once.

BEGIN;

INSERT INTO bedrock.contact_tag_catalog (slug, label, sort_order) VALUES
  ('operation_35_lt',      'Operation 35 - LT',      130),
  ('operation_35_lt_nick', 'Operation 35 - LT_Nick', 131),
  ('operation_35_staff',   'Operation 35 - Staff',   132),
  ('operation_35_pursuit', 'Operation 35 - Pursuit', 133),
  ('operation_35_other',   'Operation 35 - Other',   134)
ON CONFLICT (slug) DO UPDATE
  SET label  = EXCLUDED.label,
      -- Re-activate a tag that was previously retired; leave sort_order alone
      -- (see header).
      active = true;

COMMIT;

-- Verify:
--   SELECT slug, label, sort_order, active FROM bedrock.contact_tag_catalog
--   WHERE slug LIKE 'operation_35%' ORDER BY sort_order;
