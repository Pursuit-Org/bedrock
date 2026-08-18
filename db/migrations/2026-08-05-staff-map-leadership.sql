-- Map the leadership accounts that had no staff_user_id
-- Drafted 2026-08-05.
--
-- bedrock.staff_user_id_map ties an app login to a staff_user_id, and every write
-- on My Network / Pursuit Network is keyed by that id (bedrock.connection_status,
-- and the intro-request flow). A person with no row can OPEN the page but every
-- thumb and note is refused: "No staff mapping for this account yet."
--
-- 6 of the 13 people who can reach the Pursuit scope had no row, including 4 of
-- the 5 Executives — the audience the view was built for.
--
-- staff_user_id is NOT a sequence. It is public.users.user_id from the learning
-- platform, which is why these ids are looked up rather than allocated. Verified
-- against the people already mapped: jac=6, joanna=4, david=7, kirstie=119,
-- nick=467 all match their public.users.user_id exactly.
--
-- public.users has RLS and bedrock_user sees zero rows in it, so the ids below were
-- resolved with readonly_user (creds in ~/data-dictionary/.env) and are inlined
-- here rather than sub-selected — the app role executing this migration cannot read
-- that table.
--
-- Idempotent: ON CONFLICT DO NOTHING on the primary key, and it will not clobber an
-- existing row.

BEGIN;

INSERT INTO bedrock.staff_user_id_map (staff_user_id, email, display_name, notes)
VALUES
    -- Executives
    ( 468, 'devika@pursuit.org',   'Devika Gopal-Agge',   'leadership access 2026-08-05'),
    (1006, 'yadavan@pursuit.org',  'Yadavan Mahendraraj', 'leadership access 2026-08-05'),
    -- Admins
    (1008, 'kwame@pursuit.org',    'Kwame Assoku',        'leadership access 2026-08-05'),
    (1118, 'youssef@pursuit.org',  'Youssef Agour',       'leadership access 2026-08-05'),
    ( 731, 'zhong@pursuit.org',    'Zhong Sun',           'leadership access 2026-08-05')
ON CONFLICT (staff_user_id) DO NOTHING;

-- Guard: every id inserted must be unique on email too, or two logins would share
-- one person's votes.
DO $$
DECLARE dupes integer;
BEGIN
    SELECT count(*) INTO dupes FROM (
        SELECT lower(email) FROM bedrock.staff_user_id_map
        WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;
    IF dupes > 0 THEN
        RAISE EXCEPTION '% email(s) now map to more than one staff_user_id', dupes;
    END IF;
END $$;

COMMIT;

-- NOT INCLUDED, needs a human decision:
--   joanna.patterson@pursuit.org holds the Executive profile but does not exist in
--   public.users at all, so there is no staff_user_id to map her to. joanna@pursuit.org
--   (user_id 4) does exist and is already mapped, and also holds Executive — so this
--   looks like one person with two app logins rather than a missing id. Mapping the
--   second login to id 4 would make two accounts share one person's votes, which is
--   why it is not done here. Either retire the duplicate login or give her a
--   public.users record first.
--
-- Note: 4 staff_user_ids appear in public.staff_contact_relationships but not in this
-- map (28 distinct ids there vs 24 mapped before this migration). Those are people
-- with LinkedIn imports and no app login — harmless, they just cannot be attributed.

-- ── rollback ────────────────────────────────────────────────────────────────
-- DELETE FROM bedrock.staff_user_id_map WHERE staff_user_id IN (468, 731, 1006, 1008, 1118);
