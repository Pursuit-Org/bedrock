-- bedrock.resolve_staff_user_id(email) — look up a staff member's learning-platform id
-- Drafted 2026-08-05. MUST BE APPLIED AS postgres (or another role that can read
-- through the RLS on public.users) — see the ownership note below.
--
-- Why this exists: every write on My Network / Pursuit Network is keyed by
-- staff_user_id, which is public.users.user_id. bedrock_user holds SELECT on
-- public.users but RLS returns zero rows to it, so the app cannot resolve a new
-- staff member's id on its own. Today that means a person can open the page and
-- have every save refused until someone hand-writes a row into
-- bedrock.staff_user_id_map.
--
-- This is the same shape as the ten SECURITY DEFINER helpers already in this schema
-- (bedrock.search_builders, bedrock.builder_by_id, bedrock.match_builder_by_name …),
-- all owned by postgres for exactly this reason.
--
-- OWNERSHIP MATTERS: SECURITY DEFINER runs as the function OWNER. If bedrock_user
-- creates this, it runs as bedrock_user and RLS still returns nothing — it would
-- silently never resolve anyone. Apply it as postgres.
--
-- Exposure is deliberately minimal: one integer out, staff rows only, exact email
-- match. It cannot be used to enumerate builders or read any other column.

BEGIN;

CREATE OR REPLACE FUNCTION bedrock.resolve_staff_user_id(p_email text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
STABLE
-- Pin the search path: a SECURITY DEFINER function without this can be hijacked by
-- a caller-controlled search_path.
SET search_path = pg_catalog, public
AS $$
    SELECT u.user_id
      FROM public.users u
     WHERE lower(u.email) = lower(btrim(p_email))
       AND u.role = 'staff'
       AND coalesce(u.active, true)
     ORDER BY u.user_id
     LIMIT 1;
$$;

COMMENT ON FUNCTION bedrock.resolve_staff_user_id(text) IS
    'Active staff member''s public.users.user_id for an email, or NULL. SECURITY '
    'DEFINER because public.users has RLS that hides every row from bedrock_user. '
    'Used to auto-populate bedrock.staff_user_id_map on a staff member''s first use '
    'of My Network, so a new joiner can act immediately instead of waiting for a '
    'hand-written mapping. Returns one integer and nothing else.';

REVOKE ALL ON FUNCTION bedrock.resolve_staff_user_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bedrock.resolve_staff_user_id(text) TO bedrock_user;

COMMIT;

-- Verify after applying (as bedrock_user, which is what the app uses):
--   SELECT bedrock.resolve_staff_user_id('jac@pursuit.org');      -- expect 6
--   SELECT bedrock.resolve_staff_user_id('nick@pursuit.org');     -- expect 467
--   SELECT bedrock.resolve_staff_user_id('nobody@pursuit.org');   -- expect NULL
-- If those return NULL for jac/nick, the function was created by the wrong owner.

-- ── rollback ────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS bedrock.resolve_staff_user_id(text);
