-- PRO-100 (D10, D14, decided 10/2): one current campaign, past ones archived,
-- Tristate SMB Leaders retired.
--
--   1. bedrock.contact_tag_catalog.is_current: the campaign the Campaigns tab
--      opens on. Every slug of a grouped campaign carries it (Operation 35 is
--      five slugs). The app sets it with PUT /api/jobs/tag-campaigns/current,
--      one campaign at a time. Every other campaign is a past one: still
--      listed and selectable, with its results.
--   2. Operation 35 (operation_35_lt, _lt_nick, _staff, _pursuit, _other) is
--      current: 5 rows on 10/13.
--   3. tristate_smb_leaders is retired (active = false): no longer a campaign
--      or a tag to pick. Its 199 contacts keep the tag on their record; only
--      the catalog changes, as when commit_company was retired (2026-07-23).
--
-- Until this runs, the app reads every campaign as current (the page looks as
-- it did), and "Make current" answers 409. Deploy first or migrate first,
-- either works.
--
-- Changes are recorded in bedrock.data_fix_audit (ticket 'PRO-100', note
-- 'campaign-current'), created here if PRO-101's migrations haven't run yet.
-- To undo:
--   UPDATE bedrock.contact_tag_catalog SET active = true WHERE slug = 'tristate_smb_leaders';
--   ALTER TABLE bedrock.contact_tag_catalog DROP COLUMN is_current;
--
--     python -m scripts.apply_sql migrations/2026-10-13-campaign-current.sql

BEGIN;

CREATE TABLE IF NOT EXISTS bedrock.data_fix_audit (
    id          bigserial PRIMARY KEY,
    ticket      text NOT NULL,
    note        text NOT NULL,
    entity      text NOT NULL,        -- table changed
    row_key     text NOT NULL,        -- that row's key, as text
    field       text NOT NULL,
    old_value   text,
    new_value   text,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bedrock.contact_tag_catalog
    ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN bedrock.contact_tag_catalog.is_current IS
    'The current campaign (D10, PRO-100): shown by default on Jobs › Campaigns. Set for every slug of one campaign.';

-- 2. Operation 35 is current.
INSERT INTO bedrock.data_fix_audit (ticket, note, entity, row_key, field, old_value, new_value)
SELECT 'PRO-100', 'campaign-current', 'contact_tag_catalog', slug, 'is_current', 'false', 'true'
  FROM bedrock.contact_tag_catalog
 WHERE slug LIKE 'operation\_35\_%' AND active AND NOT is_current;

UPDATE bedrock.contact_tag_catalog
   SET is_current = true
 WHERE slug LIKE 'operation\_35\_%' AND active AND NOT is_current;

-- 3. Tristate SMB Leaders is retired.
INSERT INTO bedrock.data_fix_audit (ticket, note, entity, row_key, field, old_value, new_value)
SELECT 'PRO-100', 'campaign-current', 'contact_tag_catalog', slug, 'active', 'true', 'false'
  FROM bedrock.contact_tag_catalog
 WHERE slug = 'tristate_smb_leaders' AND active;

UPDATE bedrock.contact_tag_catalog
   SET active = false, is_current = false
 WHERE slug = 'tristate_smb_leaders' AND active;

COMMIT;

-- Verify (after): five current slugs, all Operation 35, and Tristate retired.
--   SELECT slug, active, is_current FROM bedrock.contact_tag_catalog
--    WHERE is_current OR slug = 'tristate_smb_leaders' ORDER BY slug;
