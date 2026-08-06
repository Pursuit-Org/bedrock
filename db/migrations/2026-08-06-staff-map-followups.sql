-- Follow-ups exposed by applying 2026-08-05-retire-duplicate-logins.sql
-- Drafted 2026-08-06.
--
-- That migration assumed afiya.augustine@ and laziah.bernstine@ were each their
-- person's ONLY identity, so it mapped them rather than retiring them. Applying it
-- proved otherwise: bedrock.staff_user_id_map already held afiya@pursuit.org (129),
-- and public.users holds both people under their SHORT address (afiya@ = 129,
-- laziah@ = 9). So the dotted rows are seed artefacts like the other seven, and the
-- short address is what each will actually sign in with.
--
-- Consequences to fix:
--   * the afiya insert was a no-op (PK 129 was taken) — nothing to undo, just retire
--     the seed row;
--   * the laziah insert DID land, pointing id 9 at the dotted address. Left alone,
--     signing in as laziah@ would resolve id 9, find it claimed by a live login, and
--     leave her unmapped. Repoint it to the address public.users actually uses.
--
-- Also maps two accounts that only surfaced once the noise was cleared:
--   frances@pursuit.org (334) — correct address, simply never mapped
--   joe@pursuit.org     (1007) — signed in 2026-07-10, role='admin'
--
-- Idempotent.

BEGIN;

-- ── 1. point id 9 at the address the learning platform uses ─────────────────
UPDATE bedrock.staff_user_id_map
   SET email = 'laziah@pursuit.org',
       notes = coalesce(notes,'') || ' | repointed to the public.users address 2026-08-06',
       updated_at = now()
 WHERE staff_user_id = 9
   AND lower(email) = 'laziah.bernstine@pursuit.org';

-- ── 2. retire the last two seeded duplicates ────────────────────────────────
-- Same 2026-03-25 bulk seed, google_id NULL, never signed into.
UPDATE public.org_users
   SET is_active = false, updated_at = now()
 WHERE lower(email) IN ('afiya.augustine@pursuit.org', 'laziah.bernstine@pursuit.org')
   AND is_active;

-- ── 3. map the two accounts that were simply never mapped ───────────────────
-- Ids from public.users via readonly_user; bedrock_user cannot read it (RLS).
-- joe@ is role='admin' — a reminder that Pursuit staff are split across the
-- 'staff' and 'admin' roles there, which is why resolve_staff_user_id accepts both.
INSERT INTO bedrock.staff_user_id_map (staff_user_id, email, display_name, notes)
VALUES
    ( 334, 'frances@pursuit.org', 'Frances',        'never mapped, 2026-08-06'),
    (1007, 'joe@pursuit.org',     'Joe Fabisevich', 'never mapped, 2026-08-06')
ON CONFLICT (staff_user_id) DO NOTHING;

-- ── guard: no staff_user_id may serve two ACTIVE logins ─────────────────────
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

-- Still unmappable, needs a learning-platform record first:
--   angielausche@pursuit.org  (Relationship Manager)
-- Untouched service / placeholder accounts:
--   systems@pursuit.org, nobody@pursuit.org, bug-fix-agent@pursuit-factory.local

-- ── rollback ────────────────────────────────────────────────────────────────
-- UPDATE bedrock.staff_user_id_map SET email='laziah.bernstine@pursuit.org' WHERE staff_user_id=9;
-- UPDATE public.org_users SET is_active=true WHERE lower(email) IN
--   ('afiya.augustine@pursuit.org','laziah.bernstine@pursuit.org');
-- DELETE FROM bedrock.staff_user_id_map WHERE staff_user_id IN (334, 1007);
