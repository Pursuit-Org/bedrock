-- Projects schema — idempotent (safe to re-run)
-- All tables live in the bedrock schema on segundo-db

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Schema must already exist on segundo-db (owned by postgres, bedrock_user has CREATE + USAGE)
-- For local dev: CREATE SCHEMA IF NOT EXISTS bedrock;
DO $$ BEGIN
    CREATE SCHEMA IF NOT EXISTS bedrock;
EXCEPTION
    WHEN insufficient_privilege THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bedrock.project (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.workstream (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.milestone (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workstream_id UUID NOT NULL REFERENCES bedrock.workstream(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'On Track'
                  CHECK (status IN ('On Track', 'At Risk', 'Needs Attention', 'Completed')),
    priority      TEXT NOT NULL DEFAULT 'Now'
                  CHECK (priority IN ('Now', 'Later', 'On-going')),
    owner         TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    source_links  TEXT[] NOT NULL DEFAULT '{}',
    sort_order    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.project_task (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    milestone_id  UUID NOT NULL REFERENCES bedrock.milestone(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'Not Started'
                  CHECK (status IN ('Not Started', 'In Progress', 'Completed', 'Blocked', 'On Hold')),
    owner         TEXT NOT NULL DEFAULT '',
    deadline      DATE,
    description   TEXT NOT NULL DEFAULT '',
    updates       TEXT NOT NULL DEFAULT '',
    links         TEXT[] NOT NULL DEFAULT '{}',
    depends_on    UUID[] NOT NULL DEFAULT '{}',
    sort_order    INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add start_date for Gantt chart support (idempotent)
DO $$ BEGIN
    ALTER TABLE bedrock.project_task ADD COLUMN start_date DATE;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Soft-delete columns for project hierarchy (M18 — data loss prevention)
-- Pattern: proven in bedrock.activity (see line ~403)
-- ---------------------------------------------------------------------------
DO $$ BEGIN ALTER TABLE bedrock.project ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.project ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bedrock.workstream ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.workstream ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bedrock.milestone ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.milestone ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE bedrock.project_task ADD COLUMN deleted_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.project_task ADD COLUMN deleted_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Ownership columns for project (M19 — project ownership model)
-- ---------------------------------------------------------------------------
DO $$ BEGIN ALTER TABLE bedrock.project ADD COLUMN owner_email TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bedrock.project ADD COLUMN created_by TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Project contributors (M19 — many-to-many editors)
CREATE TABLE IF NOT EXISTS bedrock.project_contributor (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    user_email  TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('editor')),
    added_by    TEXT,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_contributor_project ON bedrock.project_contributor(project_id);
CREATE INDEX IF NOT EXISTS idx_contributor_email ON bedrock.project_contributor(user_email);

-- Partial indexes for soft-delete filtering (follows activity pattern, line ~420)
CREATE INDEX IF NOT EXISTS idx_project_not_deleted ON bedrock.project(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workstream_not_deleted ON bedrock.workstream(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_milestone_not_deleted ON bedrock.milestone(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_task_not_deleted ON bedrock.project_task(deleted_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Multi-owner support (2026-04-21) — owner_ids references public.org_users.id
-- owner TEXT is repurposed as the free-text "Other" escape hatch
-- (for non-user labels like McKinsey, Hudson Ferris, PBD, TBD).
-- ---------------------------------------------------------------------------
ALTER TABLE bedrock.milestone     ADD COLUMN IF NOT EXISTS owner_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE bedrock.project_task  ADD COLUMN IF NOT EXISTS owner_ids UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_milestone_owner_ids     ON bedrock.milestone    USING GIN(owner_ids);
CREATE INDEX IF NOT EXISTS idx_project_task_owner_ids  ON bedrock.project_task USING GIN(owner_ids);

-- Updated-at trigger
CREATE OR REPLACE FUNCTION bedrock.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY['project', 'workstream', 'milestone', 'project_task'])
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%s_updated_at ON bedrock.%I; '
            'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON bedrock.%I '
            'FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();',
            t, t, t, t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Salesforce Task Dependencies (local storage — SF has no native dependency support)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.sf_task_dependency (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id         TEXT NOT NULL,
    depends_on_id   TEXT NOT NULL,
    external_source TEXT NOT NULL DEFAULT 'salesforce',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_sf_dep_task ON bedrock.sf_task_dependency(task_id);
CREATE INDEX IF NOT EXISTS idx_sf_dep_depends ON bedrock.sf_task_dependency(depends_on_id);

COMMENT ON TABLE bedrock.sf_task_dependency IS
  'Stores dependency edges between external CRM tasks. Salesforce Task objects '
  'have no native dependency support, so this is stored locally. '
  'Migration note: when moving off Salesforce, convert these edges to '
  'project_task.depends_on UUID arrays (the native project task dependency model).';

-- ---------------------------------------------------------------------------
-- Salesforce Task ↔ Project Bridge (local link — SF tasks appear in Project views)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.sf_task_project (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_task_id      TEXT NOT NULL,
    external_source TEXT NOT NULL DEFAULT 'salesforce',
    project_id      UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    milestone_id    UUID REFERENCES bedrock.milestone(id) ON DELETE SET NULL,
    sort_order      INT DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sf_task_id)
);
CREATE INDEX IF NOT EXISTS idx_stp_project ON bedrock.sf_task_project(project_id);
CREATE INDEX IF NOT EXISTS idx_stp_source ON bedrock.sf_task_project(external_source);

COMMENT ON TABLE bedrock.sf_task_project IS
  'Bridge table linking external CRM tasks (currently Salesforce) to local projects. '
  'This is the critical coupling point between the external CRM and local project management. '
  'When migrating off Salesforce: (1) sf_task_id maps to the external Task ID, '
  '(2) external_source identifies which CRM system the task came from, '
  '(3) all task data lives in the CRM — this table only stores the relationship. '
  'Migration path: create project_task rows from CRM data, then drop this table.';

COMMENT ON COLUMN bedrock.sf_task_project.sf_task_id IS
  'External CRM task identifier. Salesforce format: 00T + 12/15 alphanumeric chars. '
  'Stored as TEXT to accommodate any CRM ID format after migration.';

COMMENT ON COLUMN bedrock.sf_task_project.external_source IS
  'CRM system this task originates from. Currently always "salesforce". '
  'Added for forward-compatibility when migrating to a different CRM.';

-- Add opportunity_id to project table for opportunity-based projects
DO $$ BEGIN
    ALTER TABLE bedrock.project ADD COLUMN opportunity_id TEXT;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Project ↔ Opportunity many-to-many junction
-- Supports multi-Opportunity campaigns and cross-Opportunity dependencies
-- (e.g., Amazon funding contingent on Google commitment)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.project_opportunity (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    opportunity_id  TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'linked',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_po_project ON bedrock.project_opportunity(project_id);
CREATE INDEX IF NOT EXISTS idx_po_opp ON bedrock.project_opportunity(opportunity_id);

COMMENT ON TABLE bedrock.project_opportunity IS
  'Many-to-many link between local Projects and CRM Opportunities. '
  'Supports multi-Opportunity campaigns (e.g., donor dependencies across Opps). '
  'opportunity_id is TEXT to accommodate Salesforce IDs now and any CRM ID format later. '
  'Migration note: replaces the singular project.opportunity_id column for new usage.';

-- ---------------------------------------------------------------------------
-- Project ↔ Account / Contact / Award (Many-to-Many)
-- Same shape as project_opportunity — text IDs for SF compatibility.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.project_account (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    account_id  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_pa_project ON bedrock.project_account(project_id);
CREATE INDEX IF NOT EXISTS idx_pa_account ON bedrock.project_account(account_id);

CREATE TABLE IF NOT EXISTS bedrock.project_contact (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    contact_id  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_project ON bedrock.project_contact(project_id);
CREATE INDEX IF NOT EXISTS idx_pc_contact ON bedrock.project_contact(contact_id);

CREATE TABLE IF NOT EXISTS bedrock.project_award (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES bedrock.project(id) ON DELETE CASCADE,
    award_id    UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, award_id)
);
CREATE INDEX IF NOT EXISTS idx_paw_project ON bedrock.project_award(project_id);
CREATE INDEX IF NOT EXISTS idx_paw_award ON bedrock.project_award(award_id);

-- ---------------------------------------------------------------------------
-- Permission Profiles & User Roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.permission_profile (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    is_default  BOOLEAN DEFAULT false,
    permissions JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bedrock.app_user (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_user_id  TEXT UNIQUE,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT DEFAULT '',
    profile_id  UUID REFERENCES bedrock.permission_profile(id) ON DELETE SET NULL,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ── Phase B-1 (Claim 3): link bedrock.app_user → public.org_users ──
-- Other Pursuit internal tools (Product Discovery pd_*, org_activity_log, org_comments)
-- use public.org_users as the canonical staff identity table. Bedrock historically
-- maintained its own bedrock.app_user without a link, creating identity drift.
-- This adds a non-breaking FK so Bedrock can join to platform staff identity by ID.
-- Auto-populated lazily on each login via routes/permissions.py:get_user_permissions().
-- ON DELETE SET NULL preserves Bedrock audit trail (locked_by, granted_by, etc.)
-- when a staff member is removed from public.org_users.
DO $$ BEGIN
    ALTER TABLE bedrock.app_user
        ADD COLUMN IF NOT EXISTS org_user_id UUID NULL;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE bedrock.app_user
        ADD CONSTRAINT app_user_org_user_id_fkey
        FOREIGN KEY (org_user_id) REFERENCES public.org_users(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN insufficient_privilege THEN
        -- public.org_users may not exist on local-dev databases. Log and continue.
        RAISE NOTICE 'Skipped FK to public.org_users (likely local dev DB without learning platform schema)';
    WHEN undefined_table THEN
        RAISE NOTICE 'Skipped FK to public.org_users (table does not exist on this database)';
END $$;

CREATE INDEX IF NOT EXISTS idx_app_user_org_user_id
    ON bedrock.app_user(org_user_id) WHERE org_user_id IS NOT NULL;

-- ── Staff identity consolidation: org_users + user_config ──
-- public.org_users is the canonical staff identity table.
-- bedrock.user_config holds app-specific permission profile.
-- bedrock.app_user is kept during transition; will be dropped after verification.

-- Add org-wide fields to public.org_users (conditional — skips on local dev)
DO $$ BEGIN
    ALTER TABLE public.org_users ADD COLUMN IF NOT EXISTS sf_user_id TEXT UNIQUE;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped ALTER on public.org_users (run manually as superuser)';
    WHEN undefined_table THEN
        RAISE NOTICE 'Skipped ALTER on public.org_users (table does not exist)';
    WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.org_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped ALTER on public.org_users (run manually as superuser)';
    WHEN undefined_table THEN
        RAISE NOTICE 'Skipped ALTER on public.org_users (table does not exist)';
    WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bedrock.user_config (
    org_user_id     UUID PRIMARY KEY,
    profile_id      UUID REFERENCES bedrock.permission_profile(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE bedrock.user_config
        ADD CONSTRAINT user_config_org_user_fkey
        FOREIGN KEY (org_user_id) REFERENCES public.org_users(id) ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped FK to public.org_users for user_config (restricted role)';
    WHEN undefined_table THEN
        RAISE NOTICE 'Skipped FK to public.org_users for user_config (table does not exist)';
END $$;

CREATE TABLE IF NOT EXISTS bedrock.opportunity_lock (
    sf_opportunity_id TEXT PRIMARY KEY,
    locked_by         TEXT NOT NULL,
    locked_at         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opp_lock_locked_by ON bedrock.opportunity_lock(locked_by);

-- ── Sprint A Migration: 4-profile rollout (idempotent) ──
-- Runs BEFORE seed INSERTs. On first run: renames/deletes old profiles.
-- On subsequent runs: UPDATEs match 0 rows, DELETEs match 0 rows. Safe.

-- Step 1: Rename Fundraiser → Relationship Manager (preserves UUID)
UPDATE bedrock.permission_profile
SET name = 'Relationship Manager',
    description = 'Edit own opportunities and tasks, create accounts and contacts — no projects, no Pebble',
    permissions = '{
        "view_opportunities": true,
        "edit_own_opportunities": true,
        "edit_all_opportunities": false,
        "create_opportunities": true,
        "bulk_update_opportunities": false,
        "lock_own_opportunities": true,
        "reassign_opportunities": false,
        "view_tasks": true,
        "edit_own_tasks": true,
        "edit_all_tasks": false,
        "create_tasks": true,
        "edit_accounts": true,
        "create_accounts": true,
        "edit_contacts": true,
        "create_contacts": true,
        "edit_payments": false,
        "create_payments": false,
        "view_projects": true,
        "edit_projects": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": false,
        "create_sage_invoices": false,
        "match_invoices": false,
        "manage_payment_schedules": false,
        "generate_financial_reports": false,
        "use_pebble_chat": false,
        "use_pebble_research": false,
        "pebble_crm_write": false,
        "trigger_data_sync": false,
        "manage_users_roles": false,
        "edit_permission_profiles": false
    }'::jsonb
WHERE name = 'Fundraiser';

-- Step 2: Delete Manager profile (only if no users assigned)
DELETE FROM bedrock.permission_profile
WHERE name = 'Manager'
  AND NOT EXISTS (SELECT 1 FROM bedrock.app_user WHERE profile_id = bedrock.permission_profile.id);

-- ── Seed permission profiles (idempotent via ON CONFLICT) ──

INSERT INTO bedrock.permission_profile (name, description, is_default, permissions)
VALUES (
    'Admin',
    'Full access to all features',
    false,
    '{
        "view_opportunities": true,
        "edit_own_opportunities": true,
        "edit_all_opportunities": true,
        "create_opportunities": true,
        "bulk_update_opportunities": true,
        "lock_own_opportunities": true,
        "reassign_opportunities": true,
        "view_tasks": true,
        "edit_own_tasks": true,
        "edit_all_tasks": true,
        "create_tasks": true,
        "edit_accounts": true,
        "create_accounts": true,
        "edit_contacts": true,
        "create_contacts": true,
        "edit_payments": true,
        "create_payments": true,
        "view_projects": true,
        "edit_projects": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": true,
        "create_sage_invoices": true,
        "match_invoices": true,
        "manage_payment_schedules": true,
        "generate_financial_reports": true,
        "use_pebble_chat": true,
        "use_pebble_research": true,
        "pebble_crm_write": true,
        "trigger_data_sync": true,
        "manage_users_roles": true,
        "edit_permission_profiles": true,
        "manage_owner_goals": true,
        "view_commitments": true,
        "manage_commitments": true
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

INSERT INTO bedrock.permission_profile (name, description, is_default, permissions)
VALUES (
    'Relationship Manager',
    'Edit any opportunity/task, create accounts and contacts, manage projects',
    true,
    '{
        "view_opportunities": true,
        "edit_own_opportunities": true,
        "edit_all_opportunities": true,
        "create_opportunities": true,
        "bulk_update_opportunities": false,
        "lock_own_opportunities": true,
        "reassign_opportunities": false,
        "view_tasks": true,
        "edit_own_tasks": true,
        "edit_all_tasks": true,
        "create_tasks": true,
        "edit_accounts": true,
        "create_accounts": true,
        "edit_contacts": true,
        "create_contacts": true,
        "edit_payments": false,
        "create_payments": false,
        "view_projects": true,
        "edit_projects": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": false,
        "create_sage_invoices": false,
        "match_invoices": false,
        "manage_payment_schedules": false,
        "generate_financial_reports": false,
        "use_pebble_chat": false,
        "use_pebble_research": false,
        "pebble_crm_write": false,
        "trigger_data_sync": false,
        "manage_users_roles": false,
        "edit_permission_profiles": false,
        "view_commitments": true,
        "manage_commitments": true
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

INSERT INTO bedrock.permission_profile (name, description, is_default, permissions)
VALUES (
    'Executive',
    'View pipeline and projects, create tasks, edit permission profiles — no Opp editing, no Pebble',
    false,
    '{
        "view_opportunities": true,
        "edit_own_opportunities": false,
        "edit_all_opportunities": false,
        "create_opportunities": false,
        "bulk_update_opportunities": false,
        "lock_own_opportunities": false,
        "reassign_opportunities": false,
        "view_tasks": true,
        "edit_own_tasks": true,
        "edit_all_tasks": false,
        "create_tasks": true,
        "edit_accounts": false,
        "create_accounts": false,
        "edit_contacts": false,
        "create_contacts": false,
        "edit_payments": false,
        "create_payments": false,
        "view_projects": true,
        "edit_projects": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": false,
        "create_sage_invoices": false,
        "match_invoices": false,
        "manage_payment_schedules": false,
        "generate_financial_reports": false,
        "use_pebble_chat": false,
        "use_pebble_research": false,
        "pebble_crm_write": false,
        "trigger_data_sync": false,
        "manage_users_roles": false,
        "edit_permission_profiles": true,
        "manage_owner_goals": true,
        "view_commitments": true,
        "manage_commitments": true
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

INSERT INTO bedrock.permission_profile (name, description, is_default, permissions)
VALUES (
    'Project Manager',
    'Full project editing, CRM read-only — no Opp or Task editing, Pebble, or system access',
    false,
    '{
        "view_opportunities": true,
        "edit_own_opportunities": false,
        "edit_all_opportunities": false,
        "create_opportunities": false,
        "bulk_update_opportunities": false,
        "lock_own_opportunities": false,
        "reassign_opportunities": false,
        "view_tasks": true,
        "edit_own_tasks": false,
        "edit_all_tasks": false,
        "create_tasks": false,
        "edit_accounts": false,
        "create_accounts": false,
        "edit_contacts": false,
        "create_contacts": false,
        "edit_payments": false,
        "create_payments": false,
        "view_projects": true,
        "edit_projects": true,
        "view_revenue_dashboard": true,
        "view_cashflow_forecasts": true,
        "view_sage_invoices_payments": false,
        "create_sage_invoices": false,
        "match_invoices": false,
        "manage_payment_schedules": false,
        "generate_financial_reports": false,
        "use_pebble_chat": false,
        "use_pebble_research": false,
        "pebble_crm_write": false,
        "trigger_data_sync": false,
        "manage_users_roles": false,
        "edit_permission_profiles": false,
        "view_commitments": true
    }'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Backfill: add Sprint A keys to Admin (auto-granted via code, but explicit for DB clarity)
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"view_projects": true, "edit_projects": true, "edit_permission_profiles": true}'::jsonb
WHERE name = 'Admin' AND NOT (permissions ? 'view_projects');

-- 2026-05-06: track when each user last logged into Bedrock so the
-- Users tab can filter to "actually logged in" rows (not just users
-- whose org_users row was created lazily via SF sync or a permission
-- check). Lives on bedrock.user_config (owned by the bedrock role)
-- because public.org_users is owned by the platform DB role.
-- Backfills user_config.last_login_at to created_at as a best-effort
-- baseline so existing users still show up in the filtered list; the
-- auth callback refreshes it on every login going forward.
ALTER TABLE bedrock.user_config
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
UPDATE bedrock.user_config
   SET last_login_at = COALESCE(last_login_at, created_at)
 WHERE last_login_at IS NULL;

-- 2026-05-06: grant full Projects access (view + edit) to all standard
-- CRM profiles. Per JR — every Bedrock user should be able to view AND
-- edit projects; PM-only edit gating was removed.
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"view_projects": true, "edit_projects": true}'::jsonb
WHERE name IN ('Relationship Manager', 'Fundraiser', 'Executive', 'Project Manager');

-- 2026-05-06: grant RM/Fundraiser edit_all_opportunities + edit_all_tasks.
-- Per JR — RMs need to edit any opp/task, not just their own.
UPDATE bedrock.permission_profile
SET permissions = permissions || '{"edit_all_opportunities": true, "edit_all_tasks": true}'::jsonb
WHERE name IN ('Relationship Manager', 'Fundraiser');

-- ── Permission unlock request table ──

CREATE TABLE IF NOT EXISTS bedrock.permission_unlock_request (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    requester_email TEXT NOT NULL,
    profile_id      UUID NOT NULL REFERENCES bedrock.permission_profile(id) ON DELETE CASCADE,
    permission_key  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_note      TEXT DEFAULT '',
    created_at      TIMESTAMPTZ DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_unlock_req_status ON bedrock.permission_unlock_request(status);

-- ---------------------------------------------------------------------------
-- Activities (synced from SF Tasks + Events, plus manual/extension entries)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.activity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Salesforce identifiers (for mirror sync)
    sf_id TEXT UNIQUE,
    sf_type TEXT CHECK (sf_type IN ('Task', 'Event')),

    -- Core fields
    type TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'note', 'slack-message', 'calendar-event')),
    subject TEXT NOT NULL,
    description TEXT,
    description_html TEXT,
    activity_date TIMESTAMPTZ NOT NULL,

    -- Association (Opportunity-first model)
    opportunity_id TEXT,
    account_id TEXT,
    contact_ids TEXT[] DEFAULT '{}',
    project_task_id UUID REFERENCES bedrock.project_task(id) ON DELETE SET NULL,
    sf_task_id TEXT,

    -- Source tracking
    source TEXT NOT NULL CHECK (source IN ('salesforce', 'extension', 'manual', 'gmail-sync', 'calendar-sync')),
    source_ref TEXT,
    source_thread_id TEXT,

    -- Email-specific fields
    email_from TEXT,
    email_to TEXT[],
    email_cc TEXT[],
    email_snippet TEXT,

    -- Meeting-specific fields
    meeting_duration_minutes INTEGER,
    meeting_attendees JSONB,
    meeting_location TEXT,

    -- Attachments (GCS URLs — populated by extension in M15)
    attachments JSONB DEFAULT '[]',

    -- Ownership
    logged_by TEXT,
    owner_id TEXT,

    -- Sync metadata
    sf_last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ,
    sf_sync_status TEXT DEFAULT 'synced' CHECK (sf_sync_status IN ('synced', 'pending', 'failed')),

    -- Full-text search
    search_vector TSVECTOR,

    -- Soft delete (required: prevents sync resurrection of deleted records)
    deleted_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Activity indexes
CREATE INDEX IF NOT EXISTS idx_activity_opportunity ON bedrock.activity(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_activity_account ON bedrock.activity(account_id);
CREATE INDEX IF NOT EXISTS idx_activity_contact ON bedrock.activity USING GIN(contact_ids);
CREATE INDEX IF NOT EXISTS idx_activity_date ON bedrock.activity(activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON bedrock.activity(type);
CREATE INDEX IF NOT EXISTS idx_activity_source ON bedrock.activity(source);
CREATE INDEX IF NOT EXISTS idx_activity_sf_id ON bedrock.activity(sf_id);
CREATE INDEX IF NOT EXISTS idx_activity_search ON bedrock.activity USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_activity_thread ON bedrock.activity(source_thread_id);
CREATE INDEX IF NOT EXISTS idx_activity_not_deleted ON bedrock.activity(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activity_project_task ON bedrock.activity(project_task_id);

-- Full-text search trigger (subject=A weight, snippet=B, description=C)
CREATE OR REPLACE FUNCTION bedrock.activity_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.subject, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.email_snippet, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_search_vector ON bedrock.activity;
CREATE TRIGGER trg_activity_search_vector
    BEFORE INSERT OR UPDATE ON bedrock.activity
    FOR EACH ROW EXECUTE FUNCTION bedrock.activity_search_vector_update();

-- Activity updated_at trigger (reuses bedrock.set_updated_at)
DROP TRIGGER IF EXISTS trg_activity_updated_at ON bedrock.activity;
CREATE TRIGGER trg_activity_updated_at
    BEFORE UPDATE ON bedrock.activity
    FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();

-- ---------------------------------------------------------------------------
-- Pebble Tables (research pipeline, chat, batches, conflict tracking)
-- All use pebble_ prefix, no FK contamination with SF data
-- ---------------------------------------------------------------------------

-- Final research output per contact
CREATE TABLE IF NOT EXISTS bedrock.pebble_profiles (
    contact_id  TEXT PRIMARY KEY,
    profile_json TEXT,
    cost_usd    NUMERIC,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- One row per completed research run
CREATE TABLE IF NOT EXISTS bedrock.pebble_research_sessions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id    TEXT,
    profile_json  TEXT,
    cost_usd      NUMERIC,
    prospect_name TEXT,
    prospect_org  TEXT,
    status          TEXT DEFAULT 'completed',
    tier            TEXT,
    agents_log_json TEXT,
    batch_id        TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_rs_contact ON bedrock.pebble_research_sessions(contact_id);

-- Claim accuracy tracking
CREATE TABLE IF NOT EXISTS bedrock.pebble_feedback (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id    TEXT,
    correct     BOOLEAN,
    text        TEXT,
    contact_id  TEXT,
    user_id     TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Agent execution metrics
CREATE TABLE IF NOT EXISTS bedrock.pebble_harness_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name      TEXT,
    outcome         TEXT,
    cost_usd        NUMERIC,
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    attempts        INTEGER,
    elapsed_seconds NUMERIC,
    error           TEXT,
    prospect_id     TEXT,
    user_email      TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Stigmergy pheromone trail
CREATE TABLE IF NOT EXISTS bedrock.pebble_source_scores (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_name     TEXT,
    richness_score  NUMERIC,
    prospect_id     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Response deduplication with TTL
CREATE TABLE IF NOT EXISTS bedrock.pebble_api_cache (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source          TEXT,
    lookup_key      TEXT,
    response_json   TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    UNIQUE (source, lookup_key)
);

-- Ask Pebble chat sessions
CREATE TABLE IF NOT EXISTS bedrock.pebble_chat_conversations (
    id              UUID PRIMARY KEY,
    user_email      TEXT,
    title           TEXT,
    total_cost_usd  NUMERIC DEFAULT 0.0,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Chat message history
CREATE TABLE IF NOT EXISTS bedrock.pebble_chat_messages (
    id              UUID PRIMARY KEY,
    conversation_id UUID REFERENCES bedrock.pebble_chat_conversations(id),
    role            TEXT,
    content         TEXT,
    tier            TEXT,
    cost_usd        NUMERIC DEFAULT 0.0,
    metadata_json   TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_cm_conv ON bedrock.pebble_chat_messages(conversation_id);

-- Bulk research jobs
CREATE TABLE IF NOT EXISTS bedrock.pebble_research_batches (
    id                    UUID PRIMARY KEY,
    user_email            TEXT,
    total_prospects       INTEGER DEFAULT 0,
    completed_prospects   INTEGER DEFAULT 0,
    target_tier           TEXT DEFAULT 'T1',
    status                TEXT DEFAULT 'pending',
    total_cost_usd        NUMERIC DEFAULT 0.0,
    created_at            TIMESTAMPTZ DEFAULT now(),
    updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Individual prospects in a batch
CREATE TABLE IF NOT EXISTS bedrock.pebble_batch_prospects (
    id                    UUID PRIMARY KEY,
    batch_id              UUID REFERENCES bedrock.pebble_research_batches(id),
    prospect_name         TEXT,
    prospect_org          TEXT,
    current_tier          TEXT DEFAULT 'pending',
    identity_confidence   TEXT DEFAULT 'none',
    crm_status            TEXT DEFAULT 'unknown',
    result_json           TEXT,
    cost_usd              NUMERIC DEFAULT 0.0,
    created_at            TIMESTAMPTZ DEFAULT now(),
    updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_bp_batch ON bedrock.pebble_batch_prospects(batch_id);

-- Persist detected conflicts
CREATE TABLE IF NOT EXISTS bedrock.pebble_conflict_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID REFERENCES bedrock.pebble_research_sessions(id),
    contact_id      TEXT,
    conflict_type   TEXT,
    claim_a         TEXT,
    claim_b         TEXT,
    description     TEXT,
    resolution      TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pebble_cl_session ON bedrock.pebble_conflict_log(session_id);

-- Persist intermediate research state
CREATE TABLE IF NOT EXISTS bedrock.pebble_scratchpad (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id      UUID REFERENCES bedrock.pebble_research_sessions(id),
    contact_id      TEXT,
    scratchpad_json TEXT,
    status          TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);
-- M17: upgrade to UNIQUE for ON CONFLICT support in save_scratchpad()
DROP INDEX IF EXISTS bedrock.idx_pebble_sp_session;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pebble_sp_session ON bedrock.pebble_scratchpad(session_id);

-- Per-user daily cost tracking (M12 — Pebble access control)
CREATE TABLE IF NOT EXISTS bedrock.pebble_daily_usage (
    user_email  TEXT NOT NULL,
    date        DATE NOT NULL,
    total_cost_usd NUMERIC DEFAULT 0.0,
    query_count INTEGER DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_email, date)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- M17: SF Field Requirements + Prospect CRM Mapping (absorbs M14)
-- ─────────────────────────────────────────────────────────────────────────────

-- Reference table: SF field metadata from describe() audit
CREATE TABLE IF NOT EXISTS bedrock.sf_field_requirements (
    id              SERIAL PRIMARY KEY,
    sobject         TEXT NOT NULL,
    field_name      TEXT NOT NULL,
    field_label     TEXT,
    field_type      TEXT,
    is_required     BOOLEAN DEFAULT FALSE,
    has_default     BOOLEAN DEFAULT FALSE,
    default_value   TEXT,
    is_updateable   BOOLEAN DEFAULT TRUE,
    pebble_source_tier TEXT,
    notes           TEXT,
    last_verified_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(sobject, field_name)
);
CREATE INDEX IF NOT EXISTS idx_sf_field_req_sobject
    ON bedrock.sf_field_requirements(sobject);

-- Prospect → SF Contact mapping (typed columns, all nullable for soft enforcement)
CREATE TABLE IF NOT EXISTS bedrock.prospect_sf_contact (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    prospect_id         UUID NOT NULL REFERENCES bedrock.pebble_batch_prospects(id) ON DELETE CASCADE,
    last_name           TEXT,
    first_name          TEXT,
    title               TEXT,
    email               TEXT,
    phone               TEXT,
    department          TEXT,
    lead_source         TEXT,
    linkedin_url        TEXT,
    mailing_street      TEXT,
    mailing_city        TEXT,
    mailing_state       TEXT,
    mailing_postal_code TEXT,
    philanthropic_contact BOOLEAN,
    philanthropy        BOOLEAN,
    volunteer           BOOLEAN,
    notes               TEXT,
    sources             TEXT[],
    last_enriched_tier  TEXT,
    last_enriched_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(prospect_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_sf_contact_prospect
    ON bedrock.prospect_sf_contact(prospect_id);

-- Prospect → SF Account mapping
CREATE TABLE IF NOT EXISTS bedrock.prospect_sf_account (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    prospect_id         UUID NOT NULL REFERENCES bedrock.pebble_batch_prospects(id) ON DELETE CASCADE,
    name                TEXT,
    account_type        TEXT,
    industry            TEXT,
    website             TEXT,
    phone               TEXT,
    grantmaker          BOOLEAN,
    philanthropy        BOOLEAN,
    fee_for_service     BOOLEAN,
    annual_revenue      NUMERIC,
    funding_focus       TEXT,
    notes               TEXT,
    sources             TEXT[],
    last_enriched_tier  TEXT,
    last_enriched_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(prospect_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_sf_account_prospect
    ON bedrock.prospect_sf_account(prospect_id);

-- ── Phase 5C (Claim 5): writeback columns for prospect → SF push idempotency ──
-- After Pebble pushes a prospect to Salesforce, we record the resulting SF ID
-- so subsequent re-runs of the research pipeline can short-circuit instead of
-- creating duplicate SF records. Idempotent ALTER TABLE blocks.
DO $$ BEGIN
    ALTER TABLE bedrock.prospect_sf_contact
        ADD COLUMN IF NOT EXISTS sf_contact_id TEXT,
        ADD COLUMN IF NOT EXISTS sf_pushed_at  TIMESTAMPTZ;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE bedrock.prospect_sf_account
        ADD COLUMN IF NOT EXISTS sf_account_id TEXT,
        ADD COLUMN IF NOT EXISTS sf_pushed_at  TIMESTAMPTZ;
EXCEPTION
    WHEN duplicate_column THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_sf_contact_sf_id
    ON bedrock.prospect_sf_contact(sf_contact_id) WHERE sf_contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_prospect_sf_account_sf_id
    ON bedrock.prospect_sf_account(sf_account_id) WHERE sf_account_id IS NOT NULL;

-- ── Source governance (Claim 5 foundation): origin tracking on prospect tables ──
-- Every Bedrock-created prospect record gets a `source` value so the
-- platform-side Builder visibility filter can decide whether Builders
-- should see it. The CHECK constraint enforces the canonical enum from
-- source_governance.py (Bedrock side) and matches the proposed CHECK on
-- public.contacts.source / public.companies.source (platform-side ask in
-- docs/contact-source-governance.md).
DO $$ BEGIN
    ALTER TABLE bedrock.prospect_sf_contact
        ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pebble_research',
        ADD COLUMN IF NOT EXISTS enrichment_source TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE bedrock.prospect_sf_account
        ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pebble_research',
        ADD COLUMN IF NOT EXISTS enrichment_source TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE bedrock.prospect_sf_contact
        ADD CONSTRAINT prospect_sf_contact_source_chk
        CHECK (source IN (
            'linkedin_import', 'clearbit', 'manual', 'sputnik', 'platform_user_added',
            'salesforce', 'pebble_research', 'bedrock_prospect_import', 'manual_staff'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE bedrock.prospect_sf_account
        ADD CONSTRAINT prospect_sf_account_source_chk
        CHECK (source IN (
            'linkedin_import', 'clearbit', 'manual', 'sputnik', 'platform_user_added',
            'salesforce', 'pebble_research', 'bedrock_prospect_import', 'manual_staff'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Claim 4 (sf_account_company_map): SF Account ↔ public.companies bridge ──
-- Bedrock cannot write to public.companies (read-only role on public.*), so
-- the bridge lives on the Bedrock side. Populated by the matcher service in
-- services/sf_company_matcher.py, which walks SF Accounts and looks them up
-- in public.companies by case-insensitive name. ON DELETE SET NULL preserves
-- the bedrock audit row if the platform deletes a company; the SF Account
-- stays linked but the platform side becomes orphaned (admin can investigate
-- via /api/admin/sf-company-match).
CREATE TABLE IF NOT EXISTS bedrock.sf_account_company_map (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_account_id       TEXT NOT NULL,
    public_company_id   INTEGER NULL,
    confidence          TEXT NOT NULL CHECK (confidence IN (
        'exact_name',           -- lower(sf_name) = lower(companies.name)
        'normalized_name',      -- after stripping "The ", "Foundation", "Inc." etc.
        'domain',               -- matched on email/web domain
        'manual'                -- human admin confirmed via admin UI
    )),
    matched_by          TEXT,
    matched_at          TIMESTAMPTZ DEFAULT now(),
    notes               TEXT,
    UNIQUE(sf_account_id)
);

DO $$ BEGIN
    ALTER TABLE bedrock.sf_account_company_map
        ADD CONSTRAINT sf_account_company_map_company_fkey
        FOREIGN KEY (public_company_id) REFERENCES public.companies(company_id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped FK to public.companies (likely local-dev DB or restricted role)';
    WHEN undefined_table THEN
        RAISE NOTICE 'Skipped FK to public.companies (table does not exist on this database)';
END $$;

CREATE INDEX IF NOT EXISTS idx_sf_account_map_sf_id
    ON bedrock.sf_account_company_map(sf_account_id);
CREATE INDEX IF NOT EXISTS idx_sf_account_map_company_id
    ON bedrock.sf_account_company_map(public_company_id) WHERE public_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sf_account_map_confidence
    ON bedrock.sf_account_company_map(confidence);

-- Logo enrichment overlay for public.companies. Bedrock can't UPDATE
-- public.companies directly (DB role lacks write privilege), so logos
-- fetched from external APIs (Apollo via Zero CLI, etc.) land here and
-- the read endpoints LEFT JOIN this table preferring its logo_url over
-- the dead Clearbit URLs in public.companies.logo_url.
CREATE TABLE IF NOT EXISTS bedrock.company_logo_enrichment (
    public_company_id   INTEGER PRIMARY KEY,
    logo_url            TEXT NOT NULL,
    source              TEXT NOT NULL DEFAULT 'apollo_zero',
    enriched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved filter views — per-user OR shared org-wide. `scope_key`
-- namespaces the view to a list page ("pipeline", "accounts",
-- "cleanup-opportunities", etc.) so a name like "My open Q4" can
-- exist independently across pages. `is_global=true` makes a view
-- visible to every user; `owner_email` = NULL identifies a global
-- view that no one owns (created by an admin and shared org-wide).
CREATE TABLE IF NOT EXISTS bedrock.saved_view (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scope_key     TEXT NOT NULL,
    name          TEXT NOT NULL,
    /** Owner's email; NULL when the view is global (admin-curated). */
    owner_email   TEXT,
    is_global     BOOLEAN NOT NULL DEFAULT false,
    /** JSON-shaped filter payload — opaque to the backend, the
     *  frontend deserializes per-page. */
    filters       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_view_scope_owner
    ON bedrock.saved_view(scope_key, owner_email);
CREATE INDEX IF NOT EXISTS idx_saved_view_scope_global
    ON bedrock.saved_view(scope_key) WHERE is_global = true;

-- Prospect → SF Opportunity hints (research-derived suggestions)
CREATE TABLE IF NOT EXISTS bedrock.prospect_sf_opportunity (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    prospect_id             UUID NOT NULL REFERENCES bedrock.pebble_batch_prospects(id) ON DELETE CASCADE,
    suggested_name          TEXT,
    suggested_amount        NUMERIC,
    suggested_stage         TEXT DEFAULT 'Lead Gen',
    suggested_close_date    DATE,
    suggested_record_type   TEXT,
    giving_capacity_estimate NUMERIC,
    past_giving_history     TEXT,
    wealth_indicators       TEXT,
    notes                   TEXT,
    sources                 TEXT[],
    last_enriched_tier      TEXT,
    last_enriched_at        TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT now(),
    updated_at              TIMESTAMPTZ DEFAULT now(),
    UNIQUE(prospect_id)
);
CREATE INDEX IF NOT EXISTS idx_prospect_sf_opp_prospect
    ON bedrock.prospect_sf_opportunity(prospect_id);

-- Schema drift detection log (HITL review for SF field changes)
CREATE TABLE IF NOT EXISTS bedrock.sf_schema_drift_log (
    id              SERIAL PRIMARY KEY,
    sobject         TEXT NOT NULL,
    field_name      TEXT NOT NULL,
    drift_type      TEXT NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    detected_at     TIMESTAMPTZ DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT,
    action_taken    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sf_drift_unresolved
    ON bedrock.sf_schema_drift_log(resolved_at) WHERE resolved_at IS NULL;

-- Seed sf_field_requirements with describe() audit data (2026-03-30)
-- Non-boolean required fields (nillable=false, updateable=true, type!=boolean)
INSERT INTO bedrock.sf_field_requirements (sobject, field_name, field_label, field_type, is_required, has_default, is_updateable, pebble_source_tier, notes)
VALUES
    -- Opportunity: required
    ('Opportunity', 'Name',      'Name',       'string',    TRUE,  FALSE, TRUE, NULL,  'User-provided on create/edit'),
    ('Opportunity', 'StageName', 'Stage',      'picklist',  TRUE,  FALSE, TRUE, NULL,  'User-selected stage in pipeline'),
    ('Opportunity', 'CloseDate', 'Close Date', 'date',      TRUE,  FALSE, TRUE, NULL,  'User-provided expected close date'),
    ('Opportunity', 'OwnerId',   'Owner ID',   'reference', TRUE,  FALSE, TRUE, NULL,  'Auto-populated with current user'),
    -- Opportunity: key optional (Pebble can inform)
    ('Opportunity', 'Amount',       'Amount',        'currency',  FALSE, FALSE, TRUE, 'T2', 'Pebble giving capacity estimate'),
    ('Opportunity', 'AccountId',    'Account ID',    'reference', FALSE, FALSE, TRUE, 'T1', 'Linked via prospect org match'),
    ('Opportunity', 'Description',  'Description',   'textarea',  FALSE, FALSE, TRUE, 'T3', 'Pebble research summary'),
    ('Opportunity', 'Type',         'Type',          'picklist',  FALSE, FALSE, TRUE, NULL,  'User-selected'),
    ('Opportunity', 'Probability',  'Probability',   'percent',   FALSE, FALSE, TRUE, NULL,  'Auto-set from stage'),
    -- Contact: required
    ('Contact', 'LastName', 'Last Name', 'string',    TRUE,  FALSE, TRUE, 'T1', 'Extracted from prospect name'),
    ('Contact', 'OwnerId',  'Owner ID', 'reference', TRUE,  FALSE, TRUE, NULL,  'Auto-populated'),
    -- Contact: key optional (Pebble populates)
    ('Contact', 'FirstName',                      'First Name',           'string',    FALSE, FALSE, TRUE, 'T1', 'Extracted from prospect name'),
    ('Contact', 'Title',                          'Title',                'string',    FALSE, FALSE, TRUE, 'T1', 'From identity card or Wikipedia'),
    ('Contact', 'Email',                          'Email',                'email',     FALSE, FALSE, TRUE, 'T1', 'From CRM match or web search'),
    ('Contact', 'Phone',                          'Phone',                'phone',     FALSE, FALSE, TRUE, 'T2', 'From enrichment sources'),
    ('Contact', 'Department',                     'Department',           'string',    FALSE, FALSE, TRUE, 'T2', 'From affiliations dimension'),
    ('Contact', 'npsp__Primary_Affiliation__c',   'Primary Affiliation', 'reference', FALSE, FALSE, TRUE, 'T1', 'Account ID from org match'),
    ('Contact', 'LinkedIn_URL__c',                'LinkedIn URL',         'url',       FALSE, FALSE, TRUE, 'T2', 'From web search'),
    ('Contact', 'LeadSource',                     'Lead Source',          'picklist',  FALSE, FALSE, TRUE, NULL,  'User-selected'),
    ('Contact', 'Philanthropic_Contact__c',       'Philanthropic Contact','boolean',   FALSE, TRUE,  TRUE, 'T3', 'From philanthropy forager'),
    ('Contact', 'Philanthropy__c',                'Philanthropy',         'boolean',   FALSE, TRUE,  TRUE, 'T3', 'From philanthropy forager'),
    ('Contact', 'Volunteer__c',                   'Volunteer',            'boolean',   FALSE, TRUE,  TRUE, NULL,  'User-set'),
    -- Account: required
    ('Account', 'Name',    'Account Name', 'string',    TRUE,  FALSE, TRUE, 'T1', 'From prospect org name'),
    ('Account', 'OwnerId', 'Owner ID',    'reference', TRUE,  FALSE, TRUE, NULL,  'Auto-populated'),
    -- Account: key optional (Pebble populates)
    ('Account', 'Type',                    'Account Type',     'picklist', FALSE, FALSE, TRUE, 'T2', 'From OpenCorporates or Wikipedia'),
    ('Account', 'Industry',                'Industry',         'picklist', FALSE, FALSE, TRUE, 'T2', 'From Wikipedia or web search'),
    ('Account', 'Website',                 'Website',          'url',      FALSE, FALSE, TRUE, 'T2', 'From web search or Wikipedia'),
    ('Account', 'Phone',                   'Phone',            'phone',    FALSE, FALSE, TRUE, 'T2', 'From enrichment sources'),
    ('Account', 'npsp__Grantmaker__c',     'Grantmaker',       'boolean',  FALSE, TRUE,  TRUE, 'T3', 'From ProPublica 990 data'),
    ('Account', 'Philanthropy__c',         'Philanthropy',     'boolean',  FALSE, TRUE,  TRUE, 'T3', 'From philanthropy forager'),
    ('Account', 'Fee_For_Service__c',      'Fee For Service',  'boolean',  FALSE, TRUE,  TRUE, NULL,  'User-set'),
    ('Account', 'npsp__Funding_Focus__c',  'Funding Focus',    'multipicklist', FALSE, FALSE, TRUE, 'T3', 'From ProPublica program descriptions'),
    ('Account', 'AnnualRevenue',           'Annual Revenue',   'currency', FALSE, FALSE, TRUE, 'T3', 'From ProPublica 990 or SEC filings'),
    -- Payment: no non-boolean required fields
    ('npe01__OppPayment__c', 'npe01__Payment_Amount__c',  'Payment Amount',   'currency', FALSE, FALSE, TRUE, NULL, 'User-provided'),
    ('npe01__OppPayment__c', 'npe01__Scheduled_Date__c',  'Scheduled Date',   'date',     FALSE, FALSE, TRUE, NULL, 'User-provided'),
    ('npe01__OppPayment__c', 'npe01__Payment_Date__c',    'Payment Date',     'date',     FALSE, FALSE, TRUE, NULL, 'Set when paid'),
    ('npe01__OppPayment__c', 'npe01__Payment_Method__c',  'Payment Method',   'picklist', FALSE, FALSE, TRUE, NULL, 'User-selected')
ON CONFLICT (sobject, field_name) DO NOTHING;

-- Updated-at triggers for pebble tables that have updated_at columns
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'pebble_chat_conversations',
        'pebble_research_batches',
        'pebble_batch_prospects',
        'pebble_scratchpad',
        'pebble_daily_usage',
        'prospect_sf_contact',
        'prospect_sf_account',
        'prospect_sf_opportunity'
    ])
    LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%s_updated_at ON bedrock.%I; '
            'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON bedrock.%I '
            'FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();',
            t, t, t, t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Wall of Progress: per-owner annual revenue goals
-- ---------------------------------------------------------------------------
-- Goals are scoped by (sf_user_id, fiscal_year). For Pursuit, fiscal_year is
-- the calendar year (Jan 1 – Dec 31). Edit gated on manage_owner_goals.
CREATE TABLE IF NOT EXISTS bedrock.owner_goal (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_user_id      TEXT NOT NULL,
    fiscal_year     INT  NOT NULL,
    goal_amount     NUMERIC(14,2) NOT NULL CHECK (goal_amount >= 0 AND goal_amount <= 100000000),
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    created_by      TEXT,
    updated_by      TEXT,
    UNIQUE (sf_user_id, fiscal_year)
);
CREATE INDEX IF NOT EXISTS idx_owner_goal_sf_user_id ON bedrock.owner_goal(sf_user_id);
CREATE INDEX IF NOT EXISTS idx_owner_goal_fiscal_year ON bedrock.owner_goal(fiscal_year);

DO $$ BEGIN
    DROP TRIGGER IF EXISTS trg_owner_goal_updated_at ON bedrock.owner_goal;
    CREATE TRIGGER trg_owner_goal_updated_at BEFORE UPDATE ON bedrock.owner_goal
        FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
END $$;

DO $$ BEGIN
    DROP TRIGGER IF EXISTS trg_user_config_updated_at ON bedrock.user_config;
    CREATE TRIGGER trg_user_config_updated_at BEFORE UPDATE ON bedrock.user_config
        FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
END $$;
