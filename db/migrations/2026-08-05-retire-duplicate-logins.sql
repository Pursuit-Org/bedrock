-- Retire the duplicate app logins, and map the people who only have one
-- Drafted 2026-08-05.
--
-- public.org_users holds 41 active rows, 13 of which have no public.users record and
-- so cannot be given a staff_user_id. Eight of those are duplicates of a real login:
-- the same person under firstname.lastname@ as well as firstname@.
--
-- The evidence for which login is real is unambiguous:
--   * every firstname.lastname@ row was created 2026-03-25 — one bulk seed — and has
--     google_id IS NULL, i.e. nobody has ever signed in with it;
--   * the short firstname@ rows were created later (Apr–Jul), four of them have a
--     google_id, and joanna@ has already written 5 comments.
-- So the dotted rows are the seed artefacts and the short ones are the humans.
--
-- is_active is a soft flag — require_auth only checks the JWT, so this does not lock
-- anyone out of anything. It removes the seed rows from the active user lists and
-- from the duplicate-profile confusion (kirstie.chen@ was Project Manager while
-- kirstie@ is Admin; stefano.barros@ PM vs stefano@ Admin).
--
-- Idempotent.

BEGIN;

-- ── 1. retire the six seeded duplicates that have a real counterpart ─────────
UPDATE public.org_users
   SET is_active = false, updated_at = now()
 WHERE lower(email) IN (
        'greg.hogue@pursuit.org',        -- real: gregh@pursuit.org        (google_id set)
        'guilherme.barros@pursuit.org',  -- real: guilherme@pursuit.org    (google_id set)
        'joanna.patterson@pursuit.org',  -- real: joanna@pursuit.org       (5 comments)
        'kirstie.chen@pursuit.org',      -- real: kirstie@pursuit.org      (Admin)
        'stefano.barros@pursuit.org',    -- real: stefano@pursuit.org      (google_id set)
        'victoria.mayo@pursuit.org'      -- real: victoriam@pursuit.org    (google_id set)
       )
   AND is_active;

-- ── 2. the real counterparts are ALL already mapped ─────────────────────────
-- Verified 2026-08-05: gregh@=5, guilherme@=335, victoriam@=232, joanna@=4,
-- kirstie@=119, stefano@=10. So retiring the dotted seeds costs nobody access —
-- every one of these six people can already save under their real login. Nothing
-- to insert here; the step is kept as a record of the check.

-- ── 3. the two dotted logins that are NOT duplicates ────────────────────────
-- afiya.augustine@ and laziah.bernstine@ have no short-email counterpart in
-- org_users at all, so the dotted address IS their only app identity. Retiring it
-- would leave them with no login; map it instead.
INSERT INTO bedrock.staff_user_id_map (staff_user_id, email, display_name, notes)
VALUES
    (129, 'afiya.augustine@pursuit.org',  'Afiya Augustine',  'only login for this person, 2026-08-05'),
    (  9, 'laziah.bernstine@pursuit.org', 'Laziah Bernstine', 'only login for this person, 2026-08-05')
ON CONFLICT (staff_user_id) DO NOTHING;

-- ── guard: one staff_user_id must never serve two ACTIVE logins ─────────────
DO $$
DECLARE bad integer;
BEGIN
    SELECT count(*) INTO bad FROM (
        SELECT m.staff_user_id
          FROM bedrock.staff_user_id_map m
          JOIN public.org_users ou ON lower(ou.email) = lower(m.email)
         WHERE coalesce(ou.is_active, true)
         GROUP BY m.staff_user_id HAVING count(*) > 1) x;
    IF bad > 0 THEN
        RAISE EXCEPTION '% staff_user_id(s) map to more than one ACTIVE login', bad;
    END IF;
END $$;

COMMIT;

-- STILL UNMAPPABLE, and no migration can fix it — these have no public.users record
-- under any name or address, so there is no staff_user_id to point at. They need a
-- learning-platform record created first:
--   angielausche@pursuit.org     (Relationship Manager)
--   yoshiyuki.minami@pursuit.org (Project Manager)
-- Deliberately untouched (service / placeholder accounts):
--   systems@pursuit.org, nobody@pursuit.org, bug-fix-agent@pursuit-factory.local

-- ── rollback ────────────────────────────────────────────────────────────────
-- UPDATE public.org_users SET is_active = true WHERE lower(email) IN
--   ('greg.hogue@pursuit.org','guilherme.barros@pursuit.org','joanna.patterson@pursuit.org',
--    'kirstie.chen@pursuit.org','stefano.barros@pursuit.org','victoria.mayo@pursuit.org');
-- DELETE FROM bedrock.staff_user_id_map WHERE staff_user_id IN (5, 9, 129, 232, 335);
