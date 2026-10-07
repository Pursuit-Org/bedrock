# Jobs metrics: dictionary drafts (PRO-97)

Generated from `db/dictionary/jobs_metrics.json` by `python -m scripts.import_jobs_dictionary --markdown`. Edit the JSON, not this file.

PRO-97: the Jobs metrics for the data dictionary (bedrock.dd_metrics), drafted on the integration/jobs-dashboards branch. One object per concept, in the dd_metrics row shape; measures are the elements of `cuts`. `bedrock_key` is how Bedrock's services/jobs_metrics.py refers to the concept. An object with a metric_id updates that row: only the fields present change, `cuts` are merged by key, and `caveats_append` is added to the existing caveats. An object without one is a new row. scripts/import_jobs_dictionary.py applies this file (dry run by default).

## Employment (#171, update)

*Changes the measures below; every other measure on #171 is left as it is.*

**Caveats:** One placement rule for every measure here (decided 10/2, D2 and D4; settled 10/7, Nina): a builder is placed when they have an employment record with pay recorded, that isn't pro bono, isn't at the `pipeline` stage, has started (a missing start date counts and is a data gap to fill), isn't on an opportunity deleted as a data-entry error, and belongs to someone not excluded from metrics. Pursuit's own hires count whatever their role is now. Unpriced contract or freelance work doesn't count (8/16). Each builder counts once. Full-time is the core number; all paid work can be viewed.

Trials: D2 says trials count as placed. Until PRO-99 builds that, a running trial is reported beside the number (trials_running), not in it.

Left the role: a builder who left still counts as placed (default from 10/2, open call); actively_employed_count says how many are still in the role.

ever_employed_count.ever_employed_any_paid and builders_with_paid_work are the same number; consolidate them when the group confirms.

Replaces the retired FT Roles Secured (#173) and Builders with Paid Work (#174) on the Jobs Overview.

### Placed (ever) (`ever_employed_count`, draft)

Builders ever placed: at least one employment record that counts under this entry's placement rule. full_time is the Jobs Overview's "placed full-time"; ever_employed_any_paid is all paid work. Cumulative: a builder who left the role still counts.

- Counts: Builders with a counted placement
- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
)
SELECT count(DISTINCT user_id) AS ever_employed_any_paid,
       count(DISTINCT user_id) FILTER (WHERE employment_type = 'full_time') AS full_time
FROM placed
```

</details>

### In the role now (`actively_employed_count`, draft)

Placed builders who are in the job today: the record is active and hasn't reached its end date. full_time is the Overview card's "still in role".

- Counts: Placed builders in the role today
- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
)
SELECT count(DISTINCT user_id) FILTER (WHERE (engagement_stage = 'active' AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'America/New_York')::date))) AS actively_employed_any_paid,
       count(DISTINCT user_id) FILTER (WHERE employment_type = 'full_time' AND (engagement_stage = 'active' AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'America/New_York')::date))) AS full_time
FROM placed
```

</details>

### Placed rate (completers) (`ever_employed_rate`, draft)

Of builders who completed L3, the share ever placed under this entry's placement rule.

- Counts: Placed program completers
- Divided by: Program completers (completed L3)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
),
completers AS (
  SELECT DISTINCT ue.user_id
  FROM public.user_enrollment ue
  JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
  JOIN public.course co ON co.course_id = ch.course_id
  LEFT JOIN public.users u ON u.user_id = ue.user_id
  WHERE ue.status = 'completed' AND co.level = 'L3'
    AND coalesce(u.exclude_from_metrics, false) = false
)
SELECT (SELECT count(DISTINCT p.user_id) FROM placed p JOIN completers c USING (user_id)) AS ever_employed_completers,
       (SELECT count(*) FROM completers) AS program_completers,
       round(100.0 * (SELECT count(DISTINCT p.user_id) FROM placed p JOIN completers c USING (user_id))
             / nullif((SELECT count(*) FROM completers), 0), 1) AS rate_pct
```

</details>

### In-role rate (completers) (`actively_employed_rate`, draft)

Of builders who completed L3, the share in a counted paid job today.

- Counts: Program completers in the role today
- Divided by: Program completers (completed L3)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
),
completers AS (
  SELECT DISTINCT ue.user_id
  FROM public.user_enrollment ue
  JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
  JOIN public.course co ON co.course_id = ch.course_id
  LEFT JOIN public.users u ON u.user_id = ue.user_id
  WHERE ue.status = 'completed' AND co.level = 'L3'
    AND coalesce(u.exclude_from_metrics, false) = false
)
SELECT (SELECT count(DISTINCT p.user_id) FROM placed p JOIN completers c USING (user_id) WHERE (engagement_stage = 'active' AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'America/New_York')::date))) AS employed_completers,
       (SELECT count(*) FROM completers) AS program_completers,
       round(100.0 * (SELECT count(DISTINCT p.user_id) FROM placed p JOIN completers c USING (user_id) WHERE (engagement_stage = 'active' AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'America/New_York')::date)))
             / nullif((SELECT count(*) FROM completers), 0), 1) AS rate_pct
```

</details>

### Builders with paid work (`builders_with_paid_work`, draft)

Builders with any counted paid work, full-time included, counted once each. The Jobs Overview's "Builders with paid work".

- Counts: Builders with a counted placement of any type
- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
)
SELECT count(DISTINCT user_id) AS builders_with_paid_work FROM placed
```

</details>

### Full-time roles secured (`ft_roles_secured`, draft)

Full-time placed builders plus committed full-time roles nobody fills yet (Employer pipeline: committed_roles). The Jobs Overview headline. Under an L3 cohort filter only the builders count: an unfilled role has no cohort.

- Counts: Full-time placed builders + committed open full-time roles
- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
)
SELECT (SELECT count(DISTINCT user_id) FROM placed WHERE employment_type = 'full_time')
     + (SELECT count(*) FROM (SELECT r.id, r.approx_salary FROM bedrock.jobs_role r JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id WHERE r.status = 'open' AND o.deleted_at IS NULL AND r.commitment = 'committed' AND r.is_trial = false AND (r.employment_type = 'full_time' OR (r.employment_type IS NULL AND o.deal_type = 'ft'))) cr) AS ft_roles_secured
```

</details>

### Placed full-time, % of job-ready (`placed_ft_rate`, draft)

Of the job-ready pool (#176), the share placed full-time.

- Counts: Job-ready builders placed full-time
- Divided by: Job-ready pool (#176)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
),
l3plus AS (
    SELECT DISTINCT ue.user_id
    FROM public.user_enrollment ue
    JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
    JOIN public.course co ON co.course_id = ch.course_id
    WHERE co.level = 'L3+'
  ),
  l3cohort AS (
    SELECT DISTINCT ON (ue.user_id) ue.user_id, ch.name AS segment
    FROM public.user_enrollment ue
    JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
    JOIN public.course co ON co.course_id = ch.course_id
    WHERE co.level = 'L3' AND ue.user_id IN (SELECT user_id FROM l3plus)
    ORDER BY ue.user_id, ue.enrolled_date DESC
  ),
  pool AS (
    SELECT lp.user_id, COALESCE(lc.segment, 'Other L3+') AS segment
    FROM l3plus lp LEFT JOIN l3cohort lc ON lc.user_id = lp.user_id
  )
SELECT (SELECT count(DISTINCT p.user_id) FROM placed p JOIN pool USING (user_id) WHERE p.employment_type = 'full_time') AS placed_ft,
       (SELECT count(*) FROM pool) AS job_ready,
       round(100.0 * (SELECT count(DISTINCT p.user_id) FROM placed p JOIN pool USING (user_id) WHERE p.employment_type = 'full_time')
             / nullif((SELECT count(*) FROM pool), 0), 1) AS rate_pct
```

</details>

### In a paid trial (`trials_running`, draft)

Builders in a committed paid trial that is under way: a builder fills it and its end date, if any, hasn't passed. Shown beside the placed number until PRO-99 decides how trials count (D2).

- Counts: Builders in a running committed trial
- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
SELECT count(DISTINCT r.filled_by_user_id) AS trials_running
FROM bedrock.jobs_role r JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id
WHERE o.deleted_at IS NULL AND r.commitment = 'committed' AND r.is_trial = true AND r.filled_by_user_id IS NOT NULL AND r.status <> 'cancelled' AND (r.end_date IS NULL OR r.end_date >= CURRENT_DATE)
```

</details>

## Post-program salary (#164, update)

*Changes the two measures below; every other measure on #164 is left as it is.*

**Add to caveats:** The Jobs Overview's Avg FT salary reads avg_ft_salary_placed and avg_ft_salary_secured, which use Employment's (#171) placement rule: test accounts, unstarted, `pipeline` and deleted-opportunity records are out, Pursuit's own hires are in. Each builder's highest full-time salary counts once. Replaces the retired Avg FT Salary (#175).

### Avg FT salary, placed builders (`avg_ft_salary_placed`, draft)

The average of what full-time placed builders are paid, taking each builder's highest full-time salary once. Placed is Employment's (#171) rule.

- Counts: Sum of each FT-placed builder's highest FT salary
- Divided by: FT-placed builders
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
),
per_builder AS (
  SELECT user_id, max(payment_amount) AS salary FROM placed
  WHERE employment_type = 'full_time' GROUP BY user_id
)
SELECT round(avg(salary)) AS avg_ft_salary, count(*) AS placed_builders FROM per_builder
```

</details>

### Avg FT salary, secured (`avg_ft_salary_secured`, draft)

Placed builders' salaries (as avg_ft_salary_placed) blended with the expected salary of committed full-time roles nobody fills yet. A forecast of what the cohort is earning towards, not current pay. Under an L3 cohort filter it is placed-only.

- Counts: FT-placed salaries + committed open FT roles' expected salary
- Divided by: FT-placed builders + committed open FT roles with a salary
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH placed AS (
  -- Employment (#171): the records that count as a placement.
  SELECT er.*
  FROM public.employment_records er
  LEFT JOIN public.users u ON u.user_id = er.user_id
  WHERE coalesce(u.exclude_from_metrics, false) = false          -- not a test account
    AND er.payment_amount > 0                                      -- pay recorded
    AND er.employment_type IS DISTINCT FROM 'pro_bono'
    AND er.engagement_stage IS DISTINCT FROM 'pipeline'            -- not a job yet
    AND (er.start_date IS NULL OR er.start_date <= (now() AT TIME ZONE 'America/New_York')::date)            -- has started
    AND (er.opportunity_id IS NULL OR NOT EXISTS (                 -- opportunity not deleted
          SELECT 1 FROM bedrock.jobs_opportunity dop
          WHERE dop.id = er.opportunity_id AND dop.deleted_at IS NOT NULL))
),
per_builder AS (
  SELECT user_id, max(payment_amount) AS salary FROM placed
  WHERE employment_type = 'full_time' GROUP BY user_id
)
SELECT round(avg(salary)) AS avg_ft_salary, count(*) AS salaries_counted FROM (
  SELECT salary FROM per_builder
  UNION ALL
  SELECT approx_salary FROM (SELECT r.id, r.approx_salary FROM bedrock.jobs_role r JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id WHERE r.status = 'open' AND o.deleted_at IS NULL AND r.commitment = 'committed' AND r.is_trial = false AND (r.employment_type = 'full_time' OR (r.employment_type IS NULL AND o.deal_type = 'ft'))) cr WHERE approx_salary > 0
) s
```

</details>

## Job-ready pool (L3+) (#176, update)

*Adds the `pool` measure (the total, which Bedrock reads); by_l3_cohort is left as it is.*

### Job-ready pool (`pool`, draft)

Builders ever enrolled in an L3+ course, counted once each. The denominator for placement rates on the Jobs Overview.

- Counts: Distinct builders enrolled in an L3+ course
- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH l3plus AS (
    SELECT DISTINCT ue.user_id
    FROM public.user_enrollment ue
    JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
    JOIN public.course co ON co.course_id = ch.course_id
    WHERE co.level = 'L3+'
  ),
  l3cohort AS (
    SELECT DISTINCT ON (ue.user_id) ue.user_id, ch.name AS segment
    FROM public.user_enrollment ue
    JOIN public.cohort ch ON ch.cohort_id = ue.cohort_id
    JOIN public.course co ON co.course_id = ch.course_id
    WHERE co.level = 'L3' AND ue.user_id IN (SELECT user_id FROM l3plus)
    ORDER BY ue.user_id, ue.enrolled_date DESC
  ),
  pool AS (
    SELECT lp.user_id, COALESCE(lc.segment, 'Other L3+') AS segment
    FROM l3plus lp LEFT JOIN l3cohort lc ON lc.user_id = lp.user_id
  )
SELECT count(*) AS job_ready_pool FROM pool
```

</details>

## Job retention (#123, update)

*Definition and caveats only.*

**Definition:** Whether placed builders stay employed over time, and salary at long-tenure milestones. Placed builders who have left a role still count as placed (Employment #171); how many are still in the role is Employment's actively_employed_count. Largely blocked by data: employment records carry few start and end dates.

**Add to caveats:** 10/2 (PRO-94): a builder who left the role still counts as placed; the Overview card shows how many are still in it. Whether to keep the word "placed" is open (Avni).

## Employer outreach (new)

**Stage / area:** Employer outreach

**Definition:** What the Jobs team does to open conversations with employers, week by week. Activity is an external touch the team sent: an email, a call, a meeting, a LinkedIn message or a text. Synced email and hand-logged activity both count; comments don't (D17). Each is credited to who did it: an email to its sender, never to the mailbox it was synced into.

**Base population:** Jobs-related activity by the Jobs team (Settings › Targets › Jobs), Mon–Sun weeks, New York time.

**When measured:** Calendar week, Monday to Sunday, New York time (D8). Any range can be picked.

**Segments:** Owner, Campaign

**Caveats:** "Touches" is retired as a term (D17). The Jobs team is whoever is active in Settings › Targets › Jobs today; membership has no history, so past weeks are recounted with today's team. A send stored in two mailboxes counts once, and Google Calendar notices and auto-replies are not outreach (decided 10/6, PRO-98). Jobs-related is the classifier's verdict, or a person's override of it; the account owner can tag or untag (PRO-101). The account is the contact's company name (lower-cased) until accounts are picked from a list (PRO-101).

### Outreach (`outreach_sent`, draft)

Everything the team sent: direct email, LinkedIn messages, texts and facilitated intros.

- Counts: Sends by the team in the week
- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT outreach FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Direct email (`direct_email_sent`, draft)

Emails the team sent, one per message (a follow-up counts on the day it went out). A copy stored in two mailboxes counts once; calendar notices and auto-replies don't count.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT direct_email FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### LinkedIn messages (`linkedin_message_sent`, draft)

LinkedIn messages the team logged.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT linkedin FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Texts (`text_sent`, draft)

Texts the team logged.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT text FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Facilitated intros (`facilitated_intro_sent`, draft)

Intro requests the team made that were accepted or completed, on the day they were acted on.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT intro FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Calls (`calls`, draft)

Calls the team booked: calls logged by hand and meetings on the team's calendars, each call once. A calendar meeting that someone also logged as a call (held the same New York day, with that call's contact on it, or an attendee from the account of the opportunity the call was logged on) counts once, as the logged call, credited to whoever logged it.

- Divided by: n/a (count)
- Date: booked in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT calls FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Discovery calls (`call_discovery`, draft)

Calls typed as discovery: a first real conversation with an employer, learning what they need. Nick's weekly KPI (10-12). The Owner cut's "Calls" column.

- Divided by: n/a (count)
- Date: booked in the week (Mon–Sun, New York)
- Caveat: Call type is required when a call is logged from 2026-10-07 (PRO-102); before that 2 of 176 calls had one, so earlier weeks read low. Calendar meetings read as check-in / other until someone re-tags them.

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT call_discovery FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Check-in / other calls (`call_general`, draft)

Every other call and meeting: check-ins, relationship calls, anything else, and any with no type.

- Divided by: n/a (count)
- Date: booked in the week (Mon–Sun, New York)
- Caveat: Calls logged before 2026-10-07 mostly have no type and read as check-in / other.

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT call_general FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Accounts activated (`accounts_activated`, draft)

Accounts whose first activity ever by the team falls in the week (D17). An intro counts. A meeting someone else sets up (Nick) counts when the contact enters at Call Booked.

- Counts: Accounts first worked in the week
- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM (SELECT email FROM bedrock.jobs_team_member UNION SELECT email FROM bedrock.jobs_team_change) t) AS team)
SELECT accounts_activated FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR aem.sent_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR aem.sent_at < ((SELECT end_at FROM w))::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND ((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND (((NULL)::timestamptz IS NULL OR a.activity_date >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.activity_date < ((SELECT end_at FROM w))::timestamptz) OR (a.type = 'call' AND ((NULL)::timestamptz IS NULL OR a.booked_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR a.booked_at < ((SELECT end_at FROM w))::timestamptz))) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < ((SELECT end_at FROM w))::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT team FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT team FROM w))::text[])
        AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < ((SELECT end_at FROM w))::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT team FROM w))::text[]) AND ((NULL)::timestamptz IS NULL OR h.changed_at >= (NULL)::timestamptz) AND (((SELECT end_at FROM w))::timestamptz IS NULL OR h.changed_at < ((SELECT end_at FROM w))::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
        AND coalesce((
    SELECT c.on_team FROM bedrock.jobs_team_change c
    WHERE c.email = e.sender AND (c.effective_at IS NULL OR c.effective_at <= e.ts)
    ORDER BY c.effective_at DESC NULLS LAST, c.id DESC LIMIT 1), false)
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    first_activity AS (        -- D17: the first activity ever on each account
      SELECT co, min(ts) AS first_ts FROM once, unnest(once.companies) co GROUP BY co
    )
    SELECT                     -- a meeting someone logged as a call isn't a call: the call is
      count(*) FILTER (WHERE kind IN ('email', 'linkedin', 'text', 'intro') AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS outreach,
      count(*) FILTER (WHERE kind = 'email' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS direct_email,
      count(*) FILTER (WHERE kind = 'linkedin' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS linkedin,
      count(*) FILTER (WHERE kind = 'text' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS text,
      count(*) FILTER (WHERE kind = 'intro' AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS intro,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz) AS calls,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'discovery') AS call_discovery,
      count(*) FILTER (WHERE kind IN ('call', 'meeting') AND logged_as IS NULL AND ts >= ((SELECT start_at FROM w))::timestamptz AND ts < ((SELECT end_at FROM w))::timestamptz
                         AND coalesce(call_kind, 'general') = 'general') AS call_general,
      (SELECT count(*) FROM first_activity
        WHERE first_ts >= ((SELECT start_at FROM w))::timestamptz AND first_ts < ((SELECT end_at FROM w))::timestamptz) AS accounts_activated
    FROM once
    ) q
```

</details>

### Contacted (`contacted`, draft)

Contacts at Initial Outreach now whose move there falls in the week, by the contact's owner, beside the contacts assigned in the week. Shown as contacted / (assigned + contacted).

- Counts: Contacts moved to Initial Outreach in the week (still there)
- Divided by: Those + contacts assigned in the week (still assigned)
- Date: in the week (Mon–Sun, New York)
- Caveat: PRO-100 settles one meaning of "contacted" for every tab; today Campaigns and the funnel each read it differently.

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at),
entered AS (
  SELECT m.contact_id, (CASE m.stage WHEN 'on_hold' THEN 'revisit' ELSE m.stage END) AS stage, c.owner_email,
         coalesce((SELECT max(h.changed_at) FROM bedrock.jobs_membership_stage_history h
                    WHERE h.contact_id = m.contact_id AND h.to_stage = m.stage),
                  CASE m.stage WHEN 'initial_outreach' THEN m.first_outreach_at
                               WHEN 'converted_to_opportunity' THEN m.converted_at END,
                  m.assigned_at) AS entered_at
  FROM bedrock.jobs_contact_membership m JOIN public.contacts c ON c.contact_id = m.contact_id
  WHERE m.stage IN ('assigned', 'initial_outreach')
)
SELECT count(*) FILTER (WHERE stage = 'initial_outreach') AS contacted,
       count(*) FILTER (WHERE stage = 'assigned') AS assigned
FROM entered WHERE entered_at >= (SELECT start_at FROM w) AND entered_at < (SELECT end_at FROM w)
```

</details>

### Activity depth (`activity_depth`, draft)

For every contact sitting in Initial Outreach now, how much activity anyone at Pursuit sent them in the last four weeks: 0, 1, 2, 3 or 4+. A work queue, not a weekly number.

- Divided by: Contacts in Initial Outreach now
- Date: last 4 weeks, as of now

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT now() - interval '4 weeks' AS since, (SELECT coalesce(array_agg(DISTINCT lower(email)), '{}') FROM public.org_users WHERE is_active AND email IS NOT NULL) AS senders)
SELECT CASE WHEN activity >= 4 THEN '4+' ELSE activity::text END AS bucket, count(*) AS contacts FROM (
    WITH e AS (
    WITH logged_calls AS MATERIALIZED (
      -- Every hand-logged call, with what a calendar meeting matches it on.
      SELECT c.id, ((c.activity_date AT TIME ZONE 'America/New_York')::date) AS day, c.participant_public_contact_id AS contact_id,
             nullif(lower(btrim(coalesce(o.account_name, ''))), '') AS account
      FROM bedrock.activity c
      LEFT JOIN bedrock.jobs_opportunity o ON o.id = c.jobs_opportunity_id
      WHERE c.type = 'call' AND c.source = 'manual' AND c.deleted_at IS NULL
    ),
    raw AS (
      -- Synced email, one row per message, by the message's own sender.
      SELECT 'email'::text AS kind, aem.sent_at AS ts, lower(aem.from_email) AS sender,
             a.id AS activity_id, NULL::uuid AS intro_id,
             a.participant_public_contact_id AS contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]) AS recips,
             a.subject, a.description, a.email_snippet AS snippet, a.email_from, a.source,
             NULL::text AS call_kind, NULL::uuid AS logged_as
      FROM bedrock.activity_email_message aem
      JOIN bedrock.activity a ON a.id = aem.activity_id
      WHERE aem.from_email = ANY(((SELECT senders FROM w))::text[]) AND (((SELECT since FROM w))::timestamptz IS NULL OR aem.sent_at >= ((SELECT since FROM w))::timestamptz) AND ((NULL)::timestamptz IS NULL OR aem.sent_at < (NULL)::timestamptz)
        AND a.deleted_at IS NULL AND a.type = 'email' AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- Email with no indexed messages: hand-logged, Salesforce-sourced, or
      -- synced since the index last ran. The row stands for itself, by its
      -- own sender (never the mailbox it was synced from).
      SELECT 'email', a.activity_date, lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))),
             a.id, NULL::uuid, a.participant_public_contact_id, coalesce(a.email_to, '{}'::text[]) || coalesce(a.email_cc, '{}'::text[]),
             a.subject, a.description, a.email_snippet, a.email_from, a.source, NULL::text, NULL::uuid
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type = 'email' AND (((SELECT since FROM w))::timestamptz IS NULL OR a.activity_date >= ((SELECT since FROM w))::timestamptz) AND ((NULL)::timestamptz IS NULL OR a.activity_date < (NULL)::timestamptz)
        AND lower(btrim(coalesce(substring(a.email_from from '<([^>]+)>'), nullif(a.email_from, ''), CASE WHEN a.source = 'manual' THEN a.logged_by END))) = ANY(((SELECT senders FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
        AND NOT EXISTS (SELECT 1 FROM bedrock.activity_email_message m WHERE m.activity_id = a.id)
      UNION ALL
      -- Hand-logged LinkedIn, text and calls, and meetings: whoever logged
      -- it, or whose calendar it is on. A meeting can be re-tagged with a
      -- call type; `logged_as` is the hand-logged call it is, if any.
      SELECT a.type, CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END, lower(btrim(a.logged_by)),
             a.id, NULL::uuid, a.participant_public_contact_id,
             CASE WHEN a.type = 'meeting' THEN ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att) ELSE '{}'::text[] END,
             a.subject, a.description, NULL::text, a.email_from, a.source,
             CASE WHEN a.type IN ('call', 'meeting') THEN a.call_kind END,
             CASE WHEN a.type = 'meeting' THEN (
               SELECT lc.id FROM logged_calls lc
               WHERE lc.day = ((a.activity_date AT TIME ZONE 'America/New_York')::date)
                 AND (lc.contact_id = a.participant_public_contact_id
                      OR EXISTS (
                        SELECT 1 FROM public.contacts pc
                        WHERE lower(pc.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(ARRAY(SELECT att->>'email' FROM jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att)) x))
                          AND (pc.contact_id = lc.contact_id
                               OR lower(btrim(coalesce(pc.current_company, ''))) = lc.account)))
               ORDER BY lc.id LIMIT 1) END
      FROM bedrock.activity a
      WHERE a.deleted_at IS NULL AND a.type IN ('linkedin', 'text', 'call', 'meeting')
        AND ((((SELECT since FROM w))::timestamptz IS NULL OR a.activity_date >= ((SELECT since FROM w))::timestamptz) AND ((NULL)::timestamptz IS NULL OR a.activity_date < (NULL)::timestamptz) OR (a.type = 'call' AND (((SELECT since FROM w))::timestamptz IS NULL OR a.booked_at >= ((SELECT since FROM w))::timestamptz) AND ((NULL)::timestamptz IS NULL OR a.booked_at < (NULL)::timestamptz))) AND (((SELECT since FROM w))::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END >= ((SELECT since FROM w))::timestamptz) AND ((NULL)::timestamptz IS NULL OR CASE WHEN a.type = 'call' THEN coalesce(a.booked_at, a.activity_date) ELSE a.activity_date END < (NULL)::timestamptz) AND lower(btrim(a.logged_by)) = ANY(((SELECT senders FROM w))::text[]) AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))
      UNION ALL
      -- A facilitated intro that was acted on, by who asked for it. Its
      -- subject is the ask (routes.jobs_intro.ASK_LABELS names it).
      SELECT 'intro', coalesce(ir.responded_at, ir.created_at), lower(ir.requested_by_email),
             NULL::uuid, ir.id, ir.contact_id, '{}'::text[],
             ir.specific_ask, ir.context, NULL::text, NULL::text, 'intro', NULL::text, NULL::uuid
      FROM bedrock.intro_request ir
      WHERE ir.status IN ('accepted', 'completed')
        AND lower(ir.requested_by_email) = ANY(((SELECT senders FROM w))::text[])
        AND (((SELECT since FROM w))::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) >= ((SELECT since FROM w))::timestamptz) AND ((NULL)::timestamptz IS NULL OR coalesce(ir.responded_at, ir.created_at) < (NULL)::timestamptz)
      UNION ALL
      -- The first move to Call Booked, by who moved it. A meeting someone
      -- else set up (Nick) enters here with no outreach behind it.
      SELECT 'call_booked', h.changed_at, lower(h.changed_by),
             NULL::uuid, NULL::uuid, h.contact_id, '{}'::text[],
             NULL::text, NULL::text, NULL::text, NULL::text, 'stage', NULL::text, NULL::uuid
      FROM (SELECT DISTINCT ON (contact_id) contact_id, changed_at, changed_by
              FROM bedrock.jobs_membership_stage_history
             WHERE to_stage = 'call_booked' ORDER BY contact_id, changed_at) h
      WHERE lower(h.changed_by) = ANY(((SELECT senders FROM w))::text[]) AND (((SELECT since FROM w))::timestamptz IS NULL OR h.changed_at >= ((SELECT since FROM w))::timestamptz) AND ((NULL)::timestamptz IS NULL OR h.changed_at < (NULL)::timestamptz)
    ),
    ev AS (
      SELECT r.*, reach.contact_ids, reach.companies
      FROM raw r
      CROSS JOIN LATERAL (
        SELECT coalesce(array_agg(DISTINCT c.contact_id), '{}') AS contact_ids,
               coalesce(array_agg(DISTINCT lower(btrim(c.current_company)))
                          FILTER (WHERE btrim(coalesce(c.current_company, '')) <> ''), '{}') AS companies
        FROM public.contacts c
        WHERE c.contact_id = r.contact_id
           OR lower(c.email) = ANY(ARRAY(SELECT lower(x) FROM unnest(r.recips) x))
      ) reach
    )
    SELECT ev.kind, ev.ts, ev.sender, ev.activity_id, ev.intro_id, ev.contact_id,
           ev.contact_ids, ev.companies, ev.subject, ev.description, ev.snippet,
           ev.email_from, ev.source, ev.call_kind, ev.logged_as, ev.recips AS recipients
    FROM ev 
    ),
    counted AS (               -- automatic mail is not activity
      SELECT * FROM e
      WHERE NOT (e.kind = 'email' AND (e.subject ~* '^\s*(appointment (booked|canceled|cancelled|rescheduled)|(updated |new )?invitation|accepted|declined|tentatively accepted|(canceled|cancelled) event)( with note)?\s*:' OR lower(coalesce(e.subject, '')) LIKE '%out of office%' OR lower(coalesce(e.subject, '')) LIKE '%automatic reply%' OR lower(coalesce(e.subject, '')) LIKE '%auto-reply%' OR lower(coalesce(e.subject, '')) LIKE '%autoreply%' OR lower(coalesce(e.subject, '')) LIKE '%auto reply%' OR lower(coalesce(e.subject, '')) LIKE '%ooo:%' OR lower(coalesce(e.subject, '')) LIKE '%ooo -%' OR lower(coalesce(e.subject, '')) LIKE '%away from%' OR lower(coalesce(e.subject, '')) LIKE '%on vacation%' OR lower(coalesce(e.subject, '')) LIKE '%on leave%' OR lower(coalesce(e.subject, '')) LIKE '%maternity leave%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your message%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for your email%' OR lower(coalesce(e.subject, '')) LIKE '%thank you for contacting%' OR lower(coalesce(e.subject, '')) LIKE '%undeliverable%' OR lower(coalesce(e.subject, '')) LIKE '%delivery status notification%' OR lower(coalesce(e.subject, '')) LIKE '%mail delivery%' OR lower(coalesce(e.subject, '')) LIKE '%returned mail%' OR lower(coalesce(e.subject, '')) LIKE '%slow to respond%' OR lower(coalesce(e.email_from, '')) LIKE '%mailer-daemon%' OR lower(coalesce(e.email_from, '')) LIKE '%postmaster%' OR lower(coalesce(e.email_from, '')) LIKE '%no-reply%' OR lower(coalesce(e.email_from, '')) LIKE '%noreply%' OR lower(coalesce(e.email_from, '')) LIKE '%donotreply%' OR lower(coalesce(e.email_from, '')) LIKE '%do-not-reply%'))
    ),
    once AS (                  -- a send stored in two mailboxes counts once
      SELECT DISTINCT ON (c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id) c.*
      FROM counted c
      WHERE NOT (c.kind = 'email' AND c.source = 'gmail-sync' AND EXISTS (
        SELECT 1 FROM counted d
        WHERE d.kind = 'email' AND d.source = 'gmail-sync'
          AND d.sender = c.sender AND d.ts = c.ts AND d.activity_id::text < c.activity_id::text
          AND (d.contact_ids && c.contact_ids
               OR ARRAY(SELECT lower(x) FROM unnest(d.recipients) x)
                  && ARRAY(SELECT lower(x) FROM unnest(c.recipients) x))))
      ORDER BY c.kind, coalesce(c.activity_id::text, c.intro_id::text), c.ts, c.contact_id
    ),
    reached AS (
      SELECT DISTINCT o.kind, coalesce(o.activity_id::text, o.intro_id::text) AS id, o.ts, x.cid
      FROM once o, unnest(o.contact_ids || o.contact_id) x(cid)
      WHERE o.kind <> 'call_booked' AND x.cid IS NOT NULL
    )
    SELECT m.contact_id, m.owner_email,
           (SELECT count(*) FROM reached r WHERE r.cid = m.contact_id) AS activity
    FROM bedrock.jobs_contact_membership m
    WHERE m.stage = 'initial_outreach'
    ) d GROUP BY 1 ORDER BY 1
```

</details>

### Contacts in a campaign (`campaign_contacts`, draft)

Jobs contacts carrying the campaign's tag, counted once each. Only the current campaign shows by default; past ones are archived and selectable (D10).

- Divided by: n/a (count)
- Date: as of today
- Caveat: Reference query with the PRO-100 campaign fixes: Bedrock groups tags into campaigns, and that grouping isn't reproduced here yet.

### Accounts in a campaign (`campaign_accounts`, draft)

Distinct accounts (company names) among a campaign's contacts.

- Divided by: n/a (count)
- Date: as of today
- Caveat: Reference query with the PRO-100 campaign fixes.

### Campaign contacts and accounts reached (`campaign_reached`, draft)

A campaign's contacts (and their accounts) that anyone at Pursuit has ever sent activity to. Shown on Campaigns as "Activated"; not the same as Accounts activated, which is the team's first activity on an account in a week.

- Counts: Campaign contacts (or accounts) with any activity from Pursuit
- Divided by: Campaign contacts (or accounts)
- Caveat: Reference query to be written with the PRO-100 campaign fixes; Bedrock counts it from the same events as Outreach (services/outreach_counting) for every Pursuit sender, all time.

## Employer pipeline (new)

**Stage / area:** Employer pipeline

**Definition:** Where the team's employer work stands: contacts by stage, opportunities by stage, what moved, what stalled, and the full-time roles employers have committed to. An opportunity is any positive expression of interest from an employer; "deal" is renamed "opportunity" everywhere.

**Base population:** Jobs contacts (bedrock.jobs_contact_membership) and opportunities (bedrock.jobs_opportunity, not deleted).

**When measured:** As of the end of the window for counts that stand; calendar weeks, New York time, for moves (D8).

**Segments:** Owner, Deal type, Stage, Priority, Campaign

**Caveats:** Stages read in the current vocabulary: retired stage names are folded into the stage they were migrated to (e.g. Reviewing Builders → Builder Submitted, the three On Hold stages → Closed Lost, On Hold contacts → Revisit). Open-market roles count only when Pursuit is actively pushing them, marked Low likelihood. Stalled (D3): no jobs-related activity for 2 weeks on a contact, 4 on an opportunity, 6 on an account; comments don't count; an account is stalled only when none of its contacts were touched and none of its opportunities moved.

### Committed roles (`committed_roles`, draft)

Full-time seats an employer has committed to and nobody fills yet: open, committed (not open-market), not a trial (a trial converts into its own full-time role), on a live opportunity, and full-time, typed so or untyped on a full-time opportunity.

- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
SELECT count(*) AS committed_roles FROM (SELECT r.id, r.approx_salary FROM bedrock.jobs_role r JOIN bedrock.jobs_opportunity o ON o.id = r.opportunity_id WHERE r.status = 'open' AND o.deleted_at IS NULL AND r.commitment = 'committed' AND r.is_trial = false AND (r.employment_type = 'full_time' OR (r.employment_type IS NULL AND o.deal_type = 'ft'))) cr
```

</details>

### Contacts by stage (`contacts_by_stage`, draft)

Jobs contacts by the stage they sit in now: Assigned, Initial Outreach, Scheduling, Call Booked, Converted to Opportunity, Revisit, Not a Fit.

- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
SELECT (CASE m.stage WHEN 'on_hold' THEN 'revisit' ELSE m.stage END) AS stage, count(*) AS contacts
FROM bedrock.jobs_contact_membership m JOIN public.contacts c ON c.contact_id = m.contact_id
GROUP BY 1 ORDER BY 2 DESC
```

</details>

### Contacts entering each stage (`contacts_entering_stage`, draft)

Contacts that entered each stage in the week, each contact once per stage. Read from the membership's own stamps (assigned, first outreach, converted) and the stage history.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at),
stamps AS (
  SELECT m.contact_id, 'assigned' AS stage FROM bedrock.jobs_contact_membership m
   JOIN public.contacts c ON c.contact_id = m.contact_id
   WHERE m.assigned_at >= (SELECT start_at FROM w) AND m.assigned_at < (SELECT end_at FROM w)
  UNION SELECT m.contact_id, 'initial_outreach' FROM bedrock.jobs_contact_membership m
   JOIN public.contacts c ON c.contact_id = m.contact_id
   WHERE m.first_outreach_at >= (SELECT start_at FROM w) AND m.first_outreach_at < (SELECT end_at FROM w)
  UNION SELECT m.contact_id, 'converted_to_opportunity' FROM bedrock.jobs_contact_membership m
   JOIN public.contacts c ON c.contact_id = m.contact_id
   WHERE m.converted_at >= (SELECT start_at FROM w) AND m.converted_at < (SELECT end_at FROM w)
),
hist AS (
  SELECT h.contact_id, (CASE h.to_stage WHEN 'on_hold' THEN 'revisit' ELSE h.to_stage END) AS stage
  FROM bedrock.jobs_membership_stage_history h JOIN public.contacts c ON c.contact_id = h.contact_id
  WHERE h.changed_at >= (SELECT start_at FROM w) AND h.changed_at < (SELECT end_at FROM w)
)
SELECT stage, count(*) AS contacts
FROM (SELECT * FROM stamps UNION SELECT * FROM hist) e
WHERE stage IN ('assigned', 'initial_outreach', 'scheduling', 'call_booked', 'converted_to_opportunity', 'revisit', 'not_a_fit')
GROUP BY 1 ORDER BY 2 DESC
```

</details>

### Opportunities by stage (`opportunities_by_stage`, draft)

Opportunities by the stage they sit in now, closed ones included.

- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
SELECT (CASE o.stage WHEN 'initial_outreach' THEN 'active_in_discussions' WHEN 'lead_submitted' THEN 'active_in_discussions' WHEN 'reviewing_builders' THEN 'builder_submitted' WHEN 'active_builder_interview' THEN 'builder_submitted' WHEN 'on_hold_not_interested' THEN 'closed_lost' WHEN 'on_hold_not_responsive' THEN 'closed_lost' WHEN 'on_hold_not_selected' THEN 'closed_lost' ELSE o.stage END) AS stage, count(*) AS opportunities
FROM bedrock.jobs_opportunity o WHERE o.deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC
```

</details>

### Opportunities entering each stage (`opportunities_entering_stage`, draft)

Opportunities that entered each stage in the week, each once per stage, from the stage history; an opportunity created straight into a stage enters it when created.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at),
hist AS (
  SELECT DISTINCT h.opportunity_id AS oid, (CASE h.to_stage WHEN 'initial_outreach' THEN 'active_in_discussions' WHEN 'lead_submitted' THEN 'active_in_discussions' WHEN 'reviewing_builders' THEN 'builder_submitted' WHEN 'active_builder_interview' THEN 'builder_submitted' WHEN 'on_hold_not_interested' THEN 'closed_lost' WHEN 'on_hold_not_responsive' THEN 'closed_lost' WHEN 'on_hold_not_selected' THEN 'closed_lost' ELSE h.to_stage END) AS stage
  FROM bedrock.jobs_stage_history h JOIN bedrock.jobs_opportunity o ON o.id = h.opportunity_id
  WHERE o.deleted_at IS NULL AND h.changed_at >= (SELECT start_at FROM w) AND h.changed_at < (SELECT end_at FROM w)
),
created AS (
  SELECT o.id AS oid, (CASE o.stage WHEN 'initial_outreach' THEN 'active_in_discussions' WHEN 'lead_submitted' THEN 'active_in_discussions' WHEN 'reviewing_builders' THEN 'builder_submitted' WHEN 'active_builder_interview' THEN 'builder_submitted' WHEN 'on_hold_not_interested' THEN 'closed_lost' WHEN 'on_hold_not_responsive' THEN 'closed_lost' WHEN 'on_hold_not_selected' THEN 'closed_lost' ELSE o.stage END) AS stage FROM bedrock.jobs_opportunity o
  WHERE o.deleted_at IS NULL AND o.created_at >= (SELECT start_at FROM w) AND o.created_at < (SELECT end_at FROM w)
    AND NOT EXISTS (SELECT 1 FROM bedrock.jobs_stage_history h2 WHERE h2.opportunity_id = o.id)
)
SELECT stage, count(*) AS opportunities FROM (SELECT * FROM hist UNION ALL SELECT * FROM created) e
GROUP BY 1 ORDER BY 2 DESC
```

</details>

### Open opportunities (`opportunities_open`, draft)

Opportunities open at the end of the window: created by then, in a working stage, and not closed by then. A past week shows what was open then.

- Divided by: n/a (count)
- Date: as of the end of the window

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at),
acct_last AS (
  -- The latest external activity at each opportunity's account: any contact
  -- whose company is the account, by participant link or meeting attendee.
  SELECT k, max(at) AS at FROM (
    SELECT lower(trim(c.current_company)) AS k, a.activity_date AS at
    FROM bedrock.activity a
    JOIN public.contacts c ON c.contact_id = a.participant_public_contact_id
    WHERE (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)
    UNION ALL
    SELECT lower(trim(c.current_company)), a.activity_date
    FROM bedrock.activity a,
         jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att
    JOIN public.contacts c ON lower(c.email) = lower(att->>'email')
    WHERE a.source = 'calendar-sync' AND (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)
  ) x
  WHERE coalesce(k, '') <> ''
  GROUP BY k
),
open_set AS (
  -- Opportunities open at the end of the window.
  SELECT o.*,
         greatest(o.created_at,
                  (SELECT max(h.changed_at) FROM bedrock.jobs_stage_history h
                    WHERE h.opportunity_id = o.id AND h.changed_at < (SELECT end_at FROM w)),
                  (SELECT max(a.activity_date) FROM bedrock.activity a
                    WHERE a.jobs_opportunity_id = o.id AND (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)),
                  al.at) AS last_movement
  FROM bedrock.jobs_opportunity o
  LEFT JOIN acct_last al ON al.k = lower(trim(o.account_name))
  WHERE o.deleted_at IS NULL
    AND o.created_at < (SELECT end_at FROM w)
    AND (o.closed_at IS NULL OR o.closed_at >= (SELECT end_at FROM w))
    AND (o.stage IN ('active_in_discussions', 'ask_submitted', 'active_opportunity_confirmed', 'builder_submitted', 'builder_interviewing', 'offer_contracting', 'lead_submitted', 'initial_outreach', 'reviewing_builders', 'active_builder_interview') OR (o.closed_at IS NOT NULL AND o.closed_at >= (SELECT end_at FROM w)))
)
SELECT count(*) AS opportunities_open FROM open_set
```

</details>

### New opportunities (`opportunities_new`, draft)

Opportunities created in the week.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at)
SELECT count(*) AS opportunities_new FROM bedrock.jobs_opportunity o
WHERE o.deleted_at IS NULL AND o.created_at >= (SELECT start_at FROM w) AND o.created_at < (SELECT end_at FROM w)
```

</details>

### Stalled opportunities (`stalled_opportunities`, draft)

Open opportunities with no movement for more than 4 weeks (D3): no stage change, and no external activity on the opportunity or with anyone at its account. Comments don't count.

- Counts: Open opportunities with no movement for 4+ weeks
- Divided by: Open opportunities
- Date: as of the end of the window

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at),
acct_last AS (
  -- The latest external activity at each opportunity's account: any contact
  -- whose company is the account, by participant link or meeting attendee.
  SELECT k, max(at) AS at FROM (
    SELECT lower(trim(c.current_company)) AS k, a.activity_date AS at
    FROM bedrock.activity a
    JOIN public.contacts c ON c.contact_id = a.participant_public_contact_id
    WHERE (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)
    UNION ALL
    SELECT lower(trim(c.current_company)), a.activity_date
    FROM bedrock.activity a,
         jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att
    JOIN public.contacts c ON lower(c.email) = lower(att->>'email')
    WHERE a.source = 'calendar-sync' AND (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)
  ) x
  WHERE coalesce(k, '') <> ''
  GROUP BY k
),
open_set AS (
  -- Opportunities open at the end of the window.
  SELECT o.*,
         greatest(o.created_at,
                  (SELECT max(h.changed_at) FROM bedrock.jobs_stage_history h
                    WHERE h.opportunity_id = o.id AND h.changed_at < (SELECT end_at FROM w)),
                  (SELECT max(a.activity_date) FROM bedrock.activity a
                    WHERE a.jobs_opportunity_id = o.id AND (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)),
                  al.at) AS last_movement
  FROM bedrock.jobs_opportunity o
  LEFT JOIN acct_last al ON al.k = lower(trim(o.account_name))
  WHERE o.deleted_at IS NULL
    AND o.created_at < (SELECT end_at FROM w)
    AND (o.closed_at IS NULL OR o.closed_at >= (SELECT end_at FROM w))
    AND (o.stage IN ('active_in_discussions', 'ask_submitted', 'active_opportunity_confirmed', 'builder_submitted', 'builder_interviewing', 'offer_contracting', 'lead_submitted', 'initial_outreach', 'reviewing_builders', 'active_builder_interview') OR (o.closed_at IS NOT NULL AND o.closed_at >= (SELECT end_at FROM w)))
)
SELECT count(*) FILTER (WHERE last_movement < least((SELECT end_at FROM w), now()) - interval '4 weeks') AS stalled_opportunities,
       count(*) AS opportunities_open
FROM open_set
```

</details>

### Stalled contacts (`stalled_contacts`, draft)

Contacts being worked (Assigned to Call Booked) with no external activity and no stage change for more than 2 weeks (D3). Not on a card yet.

- Counts: Open contacts quiet for 2+ weeks
- Divided by: Open contacts
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH last AS (
  SELECT m.contact_id,
         greatest(m.assigned_at,
                  (SELECT max(h.changed_at) FROM bedrock.jobs_membership_stage_history h
                    WHERE h.contact_id = m.contact_id),
                  (SELECT max(a.activity_date) FROM bedrock.activity a
                    WHERE a.participant_public_contact_id = m.contact_id AND (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))))) AS last_at
  FROM bedrock.jobs_contact_membership m
  WHERE m.stage IN ('assigned', 'initial_outreach', 'scheduling', 'call_booked')
)
SELECT count(*) FILTER (WHERE last_at IS NULL OR last_at < now() - interval '2 weeks') AS stalled_contacts,
       count(*) AS open_contacts
FROM last
```

</details>

### Stalled accounts (`stalled_accounts`, draft)

Accounts with an open contact or opportunity where no contact was touched and no opportunity moved for more than 6 weeks (D3). Not on a card yet.

- Counts: Open accounts quiet for 6+ weeks
- Divided by: Open accounts
- Date: as of today

<details><summary>Reference query</summary>

```sql
WITH open_accounts AS (
  SELECT DISTINCT lower(btrim(c.current_company)) AS k
  FROM bedrock.jobs_contact_membership m JOIN public.contacts c ON c.contact_id = m.contact_id
  WHERE m.stage IN ('assigned', 'initial_outreach', 'scheduling', 'call_booked')
    AND btrim(coalesce(c.current_company, '')) <> ''
  UNION
  SELECT DISTINCT lower(btrim(o.account_name)) FROM bedrock.jobs_opportunity o
  WHERE o.deleted_at IS NULL AND o.stage IN ('active_in_discussions', 'ask_submitted', 'active_opportunity_confirmed', 'builder_submitted', 'builder_interviewing', 'offer_contracting', 'lead_submitted', 'initial_outreach', 'reviewing_builders', 'active_builder_interview') AND btrim(coalesce(o.account_name, '')) <> ''
),
touched AS (
  SELECT lower(btrim(c.current_company)) AS k, max(a.activity_date) AS at
  FROM bedrock.activity a JOIN public.contacts c ON c.contact_id = a.participant_public_contact_id
  WHERE (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) GROUP BY 1
),
moved AS (
  SELECT lower(btrim(o.account_name)) AS k, max(h.changed_at) AS at
  FROM bedrock.jobs_stage_history h JOIN bedrock.jobs_opportunity o ON o.id = h.opportunity_id
  WHERE o.deleted_at IS NULL GROUP BY 1
)
SELECT count(*) FILTER (WHERE greatest(t.at, mv.at) IS NULL
                          OR greatest(t.at, mv.at) < now() - interval '6 weeks') AS stalled_accounts,
       count(*) AS open_accounts
FROM open_accounts oa LEFT JOIN touched t USING (k) LEFT JOIN moved mv USING (k)
```

</details>

### Closed won (`closed_won`, draft)

Opportunities whose latest stage change before the end of the window moved them to Closed Won, inside the window. A won-then-reverted misclick doesn't count.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at)
SELECT count(*) AS closed_won FROM (
  SELECT DISTINCT ON (h.opportunity_id) h.to_stage, h.changed_at
  FROM bedrock.jobs_stage_history h JOIN bedrock.jobs_opportunity o ON o.id = h.opportunity_id
  WHERE o.deleted_at IS NULL AND h.changed_at < (SELECT end_at FROM w)
  ORDER BY h.opportunity_id, h.changed_at DESC
) last_change WHERE to_stage = 'closed_won' AND changed_at >= (SELECT start_at FROM w)
```

</details>

### Closed lost (`closed_lost`, draft)

As closed_won, for Closed Lost.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at)
SELECT count(*) AS closed_lost FROM (
  SELECT DISTINCT ON (h.opportunity_id) h.to_stage, h.changed_at
  FROM bedrock.jobs_stage_history h JOIN bedrock.jobs_opportunity o ON o.id = h.opportunity_id
  WHERE o.deleted_at IS NULL AND h.changed_at < (SELECT end_at FROM w)
  ORDER BY h.opportunity_id, h.changed_at DESC
) last_change WHERE to_stage = 'closed_lost' AND changed_at >= (SELECT start_at FROM w)
```

</details>

### Won, with open tasks (`won_open_tasks`, draft)

Closed Won opportunities that still have a task not marked Completed.

- Divided by: n/a (count)
- Date: as of today

<details><summary>Reference query</summary>

```sql
SELECT count(*) AS won_open_tasks FROM bedrock.jobs_opportunity o
WHERE o.deleted_at IS NULL AND o.stage = 'closed_won' AND EXISTS (
  SELECT 1 FROM bedrock.jobs_task t WHERE t.parent_type = 'opportunity' AND t.parent_id = o.id::text
    AND t.deleted_at IS NULL AND t.status <> 'Completed')
```

</details>

### Time in stage (`time_in_stage`, draft)

Open opportunities by how long they have been in their current stage: under 2 weeks, 2–4, 4–6, 6–8, 8+. Opportunities with no recorded stage change are aged from creation.

- Divided by: Open opportunities
- Date: as of the end of the window

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at),
acct_last AS (
  -- The latest external activity at each opportunity's account: any contact
  -- whose company is the account, by participant link or meeting attendee.
  SELECT k, max(at) AS at FROM (
    SELECT lower(trim(c.current_company)) AS k, a.activity_date AS at
    FROM bedrock.activity a
    JOIN public.contacts c ON c.contact_id = a.participant_public_contact_id
    WHERE (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)
    UNION ALL
    SELECT lower(trim(c.current_company)), a.activity_date
    FROM bedrock.activity a,
         jsonb_array_elements(coalesce(a.meeting_attendees, '[]'::jsonb)) att
    JOIN public.contacts c ON lower(c.email) = lower(att->>'email')
    WHERE a.source = 'calendar-sync' AND (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)
  ) x
  WHERE coalesce(k, '') <> ''
  GROUP BY k
),
open_set AS (
  -- Opportunities open at the end of the window.
  SELECT o.*,
         greatest(o.created_at,
                  (SELECT max(h.changed_at) FROM bedrock.jobs_stage_history h
                    WHERE h.opportunity_id = o.id AND h.changed_at < (SELECT end_at FROM w)),
                  (SELECT max(a.activity_date) FROM bedrock.activity a
                    WHERE a.jobs_opportunity_id = o.id AND (a.deleted_at IS NULL AND a.type IN ('email', 'call', 'meeting', 'linkedin', 'text') AND (coalesce(a.jobs_relevance_override, a.jobs_relevance) = 'jobs' OR a.type NOT IN ('email','meeting'))) AND a.activity_date < (SELECT end_at FROM w)),
                  al.at) AS last_movement
  FROM bedrock.jobs_opportunity o
  LEFT JOIN acct_last al ON al.k = lower(trim(o.account_name))
  WHERE o.deleted_at IS NULL
    AND o.created_at < (SELECT end_at FROM w)
    AND (o.closed_at IS NULL OR o.closed_at >= (SELECT end_at FROM w))
    AND (o.stage IN ('active_in_discussions', 'ask_submitted', 'active_opportunity_confirmed', 'builder_submitted', 'builder_interviewing', 'offer_contracting', 'lead_submitted', 'initial_outreach', 'reviewing_builders', 'active_builder_interview') OR (o.closed_at IS NOT NULL AND o.closed_at >= (SELECT end_at FROM w)))
),
aged AS (
  SELECT extract(day FROM least((SELECT end_at FROM w), now()) - coalesce(
           (SELECT max(h.changed_at) FROM bedrock.jobs_stage_history h
             WHERE h.opportunity_id = s.id AND h.to_stage = s.stage), s.created_at)) AS days
  FROM open_set s
)
SELECT CASE WHEN days < 14 THEN '< 2 weeks' WHEN days < 28 THEN '2–4 weeks'
            WHEN days < 42 THEN '4–6 weeks' WHEN days < 56 THEN '6–8 weeks' ELSE '8+ weeks' END AS bucket,
       count(*) AS opportunities
FROM aged GROUP BY 1 ORDER BY min(days)
```

</details>

## Employer conversion (new)

**Stage / area:** Employer conversion

**Definition:** How employer work turns into jobs. Conversion runs between core milestones only, anchored on interviews: first stage → interview → hire. A rate counts only contacts that started at the earlier stage, so a contact added straight at Call Booked doesn't inflate it, and it uses the dates stages changed (D11).

**Base population:** Jobs contacts and opportunities, by the dates they changed stage.

**When measured:** Calendar weeks, New York time (D8).

**Segments:** Owner, Campaign, Deal type

**Caveats:** The milestone rates (D11) need interview history, which PRO-117 starts recording; until then the dashboards show the stage-to-stage rates below, and those can exceed 100% when a backlog clears. Whether outreach → call is also shown is open (Avni, PRO-94). One owner per conversion is PRO-101 (D6).

### Converted to opportunity (`contacts_converted`, draft)

Contacts converted to an opportunity in the week, by the membership's conversion date. With an owner selected, only conversions that belong to them: the contact's owner, else the account's, else whoever did the first outreach.

- Divided by: n/a (count)
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
WITH w AS (SELECT ((coalesce(nullif(current_setting('dd.window_from', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7))::timestamp AT TIME ZONE 'America/New_York') AS start_at, (((coalesce(nullif(current_setting('dd.window_to', true), '')::date, date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 1) + 1))::timestamp AT TIME ZONE 'America/New_York') AS end_at)
SELECT count(*) AS converted
FROM bedrock.jobs_contact_membership m
    JOIN public.contacts c ON c.contact_id = m.contact_id
    LEFT JOIN bedrock.jobs_account ja
      ON ja.account_key = nullif(lower(btrim(coalesce(c.current_company, ''))), '')
WHERE m.converted_at >= (SELECT start_at FROM w) AND m.converted_at < (SELECT end_at FROM w)
```

</details>

### Contact conversion, all time (`contact_cohort_conversion`, draft)

Of every contact ever assigned, the share that reached Initial Outreach; of every contact ever in Initial Outreach, the share converted to an opportunity. From the membership's stage stamps.

- Counts: Contacts that reached the later stage
- Divided by: Contacts that reached the earlier stage
- Date: as of today

<details><summary>Reference query</summary>

```sql
SELECT round(100.0 * count(*) FILTER (WHERE first_outreach_at IS NOT NULL)
             / nullif(count(*) FILTER (WHERE assigned_at IS NOT NULL), 0)) AS assigned_to_outreach_pct,
       round(100.0 * count(*) FILTER (WHERE converted_at IS NOT NULL)
             / nullif(count(*) FILTER (WHERE first_outreach_at IS NOT NULL), 0)) AS outreach_to_converted_pct
FROM bedrock.jobs_contact_membership
```

</details>

### Stage-to-stage flow (`stage_flow_conversion`, draft)

In a week, entries into the next stage divided by entries into this one (Employer pipeline: contacts_entering_stage, opportunities_entering_stage). Reported as measured, so over 100% means a backlog cleared.

- Counts: Entries into the next stage in the week
- Divided by: Entries into this stage in the week
- Date: in the week (Mon–Sun, New York)
- Caveat: Computed from the two *_entering_stage measures; D11 replaces it with milestone conversion.

### Opportunity stage ratio (`opportunity_stage_ratio`, draft)

Opportunities sitting in the next stage now divided by those in this stage now, hidden above 100%. A ratio of standing counts, not a conversion rate; the Overview's opportunity funnel shows it until D11's milestone conversion replaces it.

- Counts: Opportunities in the next stage now
- Divided by: Opportunities in this stage now
- Date: as of today
- Caveat: Retired as a rate by D11 (stage-to-stage ratios over 100%).

<details><summary>Reference query</summary>

```sql
WITH by_stage AS (
  SELECT (CASE o.stage WHEN 'initial_outreach' THEN 'active_in_discussions' WHEN 'lead_submitted' THEN 'active_in_discussions' WHEN 'reviewing_builders' THEN 'builder_submitted' WHEN 'active_builder_interview' THEN 'builder_submitted' WHEN 'on_hold_not_interested' THEN 'closed_lost' WHEN 'on_hold_not_responsive' THEN 'closed_lost' WHEN 'on_hold_not_selected' THEN 'closed_lost' ELSE o.stage END) AS stage, count(*) AS n
  FROM bedrock.jobs_opportunity o WHERE o.deleted_at IS NULL GROUP BY 1
),
ordered AS (
  SELECT s.stage, s.ord, coalesce(b.n, 0) AS n
  FROM unnest(ARRAY['active_in_discussions', 'ask_submitted', 'active_opportunity_confirmed', 'builder_submitted', 'builder_interviewing', 'offer_contracting', 'closed_won'])
       WITH ORDINALITY s(stage, ord)
  LEFT JOIN by_stage b USING (stage)
)
SELECT a.stage, b.stage AS next_stage,
       CASE WHEN a.n > 0 AND b.n <= a.n THEN round(100.0 * b.n / a.n) END AS ratio_pct
FROM ordered a JOIN ordered b ON b.ord = a.ord + 1
ORDER BY a.ord
```

</details>

### Campaign conversion (`campaign_conversion`, draft)

Of a campaign's contacts that were contacted or converted, the share converted. Shown once at least 5 contacts are in it.

- Counts: Campaign contacts converted
- Divided by: Campaign contacts contacted or converted
- Date: as of today
- Caveat: PRO-100 makes this a real rate with one meaning of "contacted"; reference query with it.

### First stage → interview (`milestone_to_interview`, blocked)

Of contacts that started at the first stage in a period, the share whose opportunity reached a builder interview (D11).

- Counts: Of those, contacts whose opportunity reached a builder interview
- Divided by: Contacts that started at the first stage in the period
- Date: in the week (Mon–Sun, New York)
- Caveat: Needs interview history (PRO-117) and contacts linked to opportunities (PRO-101).

### Interview → hire (`interview_to_hire`, blocked)

Of opportunities that reached a builder interview, the share that closed won with a hire (D11).

- Counts: Of those, opportunities closed won with a hire
- Divided by: Opportunities that reached a builder interview
- Date: in the week (Mon–Sun, New York)
- Caveat: Needs interview history (PRO-117).

## Jobs targets (new)

**Stage / area:** Targets

**Definition:** Whether the team is on track. Each number with a goal shows the goal, what was done, and the gap (done minus goal, so a shortfall is negative). Goals are set in Settings › Targets › Jobs: weekly activity goals per person and for the team, and a jobs goal per quarter.

**Base population:** bedrock.jobs_target

**Caveats:** Activity goals are weekly; a day is a fifth of the week (no daily goal when it doesn't divide to a whole number) and a month is four weeks. A team goal is either set directly or the sum of the team's personal goals. No goal reads as a dash, not zero. Opportunities converted carries a team goal only. D7 (10/3): team outreach goal 140 a week (Avni 45, Damon 45, Devika 50).

### Activity vs. goal (`activity_vs_target`, draft)

For outreach, calls, discovery calls, accounts activated and opportunities converted: the goal for the period, what was done (Employer outreach, Employer conversion), and the gap.

- Counts: Done in the period
- Divided by: Goal for the period
- Date: in the week (Mon–Sun, New York)

<details><summary>Reference query</summary>

```sql
SELECT t.metric, coalesce(t.owner_email, 'team') AS owner, t.team_mode,
       CASE WHEN t.owner_email IS NULL AND t.team_mode = 'sum'
            THEN (SELECT sum(p.value) FROM bedrock.jobs_target p
                   JOIN bedrock.jobs_team_member tm ON lower(tm.email) = lower(p.owner_email) AND tm.active
                  WHERE p.section = 'outreach' AND p.metric = t.metric)
            ELSE t.value END AS weekly_goal
FROM bedrock.jobs_target t
WHERE t.section = 'outreach'
ORDER BY t.metric, t.owner_email NULLS FIRST
```

</details>

### Jobs vs. quarterly goal (`jobs_vs_target`, draft)

Jobs per quarter against the quarterly goal: won (roles on Closed Won opportunities, or their estimate when no roles were logged, in the quarter they closed), confirmed (roles on open opportunities, by target close date) and estimated (an open opportunity's estimate minus its roles). Open opportunities past their close date, or with none, are listed apart.

- Counts: Won + confirmed + estimated jobs in the quarter
- Divided by: Quarterly jobs goal
- Date: quarter (New York)
- Caveat: Estimated jobs are unweighted; likelihood is shown beside them (open call, default).

<details><summary>Reference query</summary>

```sql
SELECT period_start AS quarter, value AS jobs_goal
FROM bedrock.jobs_target WHERE section = 'pipeline' ORDER BY period_start
```

</details>

## Jobs conventions (new)

**Stage / area:** Conventions

**Definition:** Rules every Jobs number shares.

Week (D8): a calendar week, Monday to Sunday, New York time. The Monday meeting looks at the week just ended; the Thursday meeting at the current week. Any range can be picked.

Activity (D17): an external touch the team sent: email, call, meeting, LinkedIn, text. Synced and hand-logged both count. Comments don't. "Touches" is retired.

Jobs team (D7): whoever is active in Settings › Targets › Jobs.

Stalled (D3): no jobs-related activity for 2 weeks on a contact, 4 on an opportunity, 6 on an account.

Stages: retired stage names are read as the stage they were migrated to.

Owner: who did an activity is its sender, never the mailbox. A conversion belongs to the contact's owner, else the account's, else whoever did the first outreach. D6 (intros through Nick) is open (PRO-101).

Reference queries: a query with a date window reads `dd.window_from` and `dd.window_to` (New York dates, both inclusive), e.g. SET dd.window_from = '2026-09-21'; SET dd.window_to = '2026-09-27'. With neither set it covers the last completed calendar week.
