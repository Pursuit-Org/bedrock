-- ============================================================================
-- Placement > Roles — staff-entered interview round number
-- ============================================================================
-- public.interviews is the platform's table (Pathfinder writes it too); the
-- Roles board now logs rounds into it. Staff enter which round an interview
-- is ("1, 2, 3 …") when logging, and that lives here. Nullable: Pathfinder
-- doesn't set it and existing rows have none — Bedrock numbers those by their
-- (date, interview_id) order within the application instead. Pathfinder reads
-- with SELECT *, so an extra nullable column changes nothing on its side.
--
-- Separately, Bedrock's roles need write grants on this table (INSERT, UPDATE,
-- DELETE on public.interviews + USAGE on its id sequence, for bedrock_user and
-- jobs_team) — the board's writes 503 until both are in place.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

ALTER TABLE public.interviews
    ADD COLUMN IF NOT EXISTS round_number integer;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'interviews_round_number_check'
          AND conrelid = 'public.interviews'::regclass
    ) THEN
        ALTER TABLE public.interviews
            ADD CONSTRAINT interviews_round_number_check
            CHECK (round_number IS NULL OR round_number >= 1);
    END IF;
END $$;

COMMENT ON COLUMN public.interviews.round_number IS
    'Which interview round this is, as entered by staff on the Bedrock Roles board. NULL = number by date order within the application.';
