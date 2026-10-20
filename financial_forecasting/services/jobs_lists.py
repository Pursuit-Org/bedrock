"""Jobs lists: how each one picks its rows, for its "Why these?" note (PRO-105).

A number explains itself through its dictionary entry (services/jobs_metrics).
A list has no entry, so its rule is written here, in words, beside a pointer to
the query it describes. When a list's query changes, change its words here;
tests/test_jobs_lists.py fails if a list the frontend asks for has none.

Where a rule surprises (an owner that isn't the one you'd guess, a band that
isn't the rule it's named after), the note says so plainly. The rule itself is
not changed here (decided 10/20 for PRO-105).

Each entry:
  who     who is in it
  order   how the rows are sorted
  cap     how many are listed, and what happens to the rest
  dates   what each date on a row means
  notes   what a reader wouldn't expect
"""

from __future__ import annotations

from typing import Optional

LISTS: dict[str, dict] = {
    # Jobs Home ───────────────────────────────────────────────────────────────
    # routes/jobs.py list_contacts, membership_stage=assigned + an owner rule.
    "assigned_contacts": {
        "title": "Assigned contacts",
        "who": ("Contacts whose Jobs pipeline stage is Assigned right now. With a person picked, the "
                "contacts that person owns (the contact's owner, not the pipeline's); with Everyone, all."),
        "order": "Assigned this week first, then earlier, by name within each.",
        "cap": "None: every assigned contact is listed.",
        "dates": ["The date is when the contact entered Assigned."],
        "notes": [
            "\"This week\" starts Monday at midnight on your computer's clock, not New York's.",
            "Contacted this week lists contacts who moved to Initial Outreach this week, assigned or not. "
            "\"X of Y contacted\" divides by every assigned contact, whenever they were assigned.",
        ],
    },
    # routes/jobs.py outreach_responded_contacts.
    "replied_needs_decision": {
        "title": "Replied, needs a decision",
        "who": ("Contacts in Initial Outreach whom someone on the Jobs team emailed, and who have written "
                "back since the first outreach. The reply can be a colleague's at their company. With a "
                "person picked, the contacts that person owns (the contact's owner, not who sent the "
                "email); with Everyone, contacts owned by anyone on the Jobs team."),
        "order": "Oldest reply first, so the longest wait is on top.",
        "cap": "Six are shown; Show all lists the rest.",
        "dates": ["\"Replied\" is when their latest message arrived."],
        "notes": [
            "Auto-replies and out-of-office messages aren't filtered out.",
            "A contact stays here until their stage changes, even after we've answered.",
            "The snippet is from the email thread, so it may not be the reply itself.",
        ],
    },
    # routes/jobs.py list_opportunities + opportunities_overview needs_attention.
    "opportunities_needs_attention": {
        "title": "Opportunities",
        "who": ("Open opportunities (not closed or on hold) owned by the person picked. Needs attention "
                "flags one that has sat 21 days or more in its stage, or has had no stage change and no "
                "activity for 4 weeks (the Stalled rule). Comments don't count as activity."),
        "order": "Flagged first, then longest in their stage, then most recent activity.",
        "cap": "None: every open opportunity is listed.",
        "dates": ["\"Last\" is the latest email, call, meeting, LinkedIn message or text on the "
                  "opportunity, with its contacts, or on its account."],
        "notes": ["Needs attention is wider than Stalled: 21 days in one stage flags an opportunity "
                  "even when it has recent activity."],
    },
    # routes/jobs.py interview_pipeline.
    "roles": {
        "title": "Roles",
        "who": ("Every role on an open opportunity (not closed won, closed lost or on hold) that the "
                "person picked owns, filled and cancelled roles included. An opportunity with builder "
                "applications and no roles is listed too."),
        "order": "Most interviews first, then most builders, then account name.",
        "cap": "None.",
        "dates": [],
        "notes": ["\"Open\" counts the roles still open; the rest are filled, in a trial or cancelled."],
    },
    # routes/jobs_tasks.py list_all_jobs_tasks.
    "tasks": {
        "title": "Tasks",
        "who": ("Every task not marked Completed, on opportunities, prospects and accounts, assigned to "
                "the person picked."),
        "order": "Overdue, due today, upcoming, then no due date; earliest deadline first.",
        "cap": "None.",
        "dates": ["The date is the task's deadline, read against your computer's date."],
        "notes": ["A task on a closed or deleted opportunity still shows until it's completed."],
    },
    # routes/jobs_intro.py list_intro_requests.
    "intro_requests": {
        "title": "Intro requests",
        "who": ("Always yours, whoever is picked above: open requests asking you to make an intro "
                "(For you), and the intros you asked for (Your requests)."),
        "order": "Newest first.",
        "cap": "None.",
        "dates": ["The date is when the request was made."],
        "notes": ["A builder's request you accepted is hidden unless Show closed is ticked, and with it "
                  "the Mark intro made button."],
    },
    # Outreach tab ────────────────────────────────────────────────────────────
    # routes/jobs.py outreach_activity_feed (services/outreach_counting).
    "activity_feed": {
        "title": "Activity",
        "who": ("Every email, LinkedIn message, text and facilitated intro sent in the period by the "
                "senders picked above. Calls and meetings aren't here. Automatic mail is left out, and a "
                "message in two mailboxes counts once."),
        "order": "Newest first, grouped by day, kind, stage, sender and owner.",
        "cap": "The 300 most recent; the list says when the period holds more.",
        "dates": ["\"When\" is when it was sent."],
        "notes": [
            "Owner is the contact's pipeline owner, else the account's owner; Editor is who sent it.",
            "Rows are grouped by the day in UTC, so a New York evening send can group with the next day.",
        ],
    },
    # routes/jobs.py _touch_depth.
    "activity_depth": {
        "title": "Activity depth",
        "who": ("Every contact in Initial Outreach right now, whoever owns them, Pursuit staff left out. "
                "A Sender picked above narrows it to the contacts that person owns."),
        "order": "Least activity first.",
        "cap": "Up to 40 contacts per bucket are listed; the bucket says how many more it counts.",
        "dates": [],
        "notes": ["Activity is anything anyone at Pursuit sent them in the last 4 weeks, calls and "
                  "meetings included. It doesn't follow the period or the team and staff buttons."],
    },
    # routes/jobs.py outreach_stuck (PRO-106).
    "outreach_stuck": {
        "title": "Not reached yet",
        "who": ("Contacts in the campaign picked (or every Jobs contact) that nobody at Pursuit has reached "
                "with any activity, and that never got to Call Booked. Owner is the pipeline owner, else "
                "the contact's owner. The team and staff buttons, and a Sender picked above, narrow it by owner."),
        "order": "Waiting longest first, by when the contact was assigned.",
        "cap": "None: every contact not reached is listed.",
        "dates": ["Assigned is when the contact was assigned to the Jobs pipeline.",
                  "Days waiting count from then to today."],
        "notes": ["The reason is read from what's recorded, first match wins: a pending intro request, "
                  "Revisit (with its date), Not a fit (with its reason). Nothing else records why a contact "
                  "is waiting yet (D6), so the rest say \"No reason recorded\".",
                  "It covers every week of the campaign, so it doesn't follow the period."],
    },
    # Pipeline tab ────────────────────────────────────────────────────────────
    # JobsOpportunitiesOverview OwnerWalkthrough over list_opportunities + needs_attention.
    "opportunities_set": {
        "title": "Opportunities Set",
        "who": ("Open opportunities (not closed or on hold) for the owner and type picked, in bands by "
                "priority, or by owner."),
        "order": "By last update within a band; the Stalled band by longest in stage.",
        "cap": "None.",
        "dates": ["\"Activity\" is the last activity; a flagged row shows its days in stage instead, "
                  "in amber."],
        "notes": [
            "The Stalled band (by owner) is the opportunities flagged Needs attention that aren't P1 or "
            "P2: 21 days or more in a stage, or 4 weeks without movement. It isn't the Stalled card's "
            "rule, and a P3+ opportunity in it is listed again under P3+.",
            "The flags are read at the end of the period picked.",
        ],
    },
    # routes/jobs.py opportunities_overview recent_activity.
    "recent_activity": {
        "title": "Recent Activity",
        "who": ("Opportunities added in the period, and every stage move, win and loss in it, for the "
                "owner and type picked (each opportunity's owner and type today)."),
        "order": "Wins, then moves, then new, then losses; newest first within each.",
        "cap": "Five are shown; Show more lists the rest.",
        "dates": ["The date is when it was added or moved."],
        "notes": ["An opportunity that moved twice is listed twice.",
                  "A close that was reverted reads as a move, not a win or a loss."],
    },
    # Campaigns tab ───────────────────────────────────────────────────────────
    # routes/jobs.py tag_campaigns (CAMPAIGN_CONTACTS_SQL in services/jobs_metrics).
    "campaigns": {
        "title": "Campaigns",
        "who": ("The current campaigns, each a group of contact tags; past ones are a click away. The "
                "numbers are all time."),
        "order": "Priority order; drag a row to change it.",
        "cap": "None.",
        "dates": [],
        "notes": ["Contacted means any activity from anyone at Pursuit, ever.",
                  "Conversion shows once five or more contacts have been contacted."],
    },
    # routes/jobs.py tag_campaign_records.
    "campaign_contacts": {
        "title": "Campaign contacts",
        "who": "The campaign's tagged contacts that are in the Jobs pipeline, at any stage.",
        "order": "By name.",
        "cap": "Ten are shown; Show all lists the rest.",
        "dates": ["\"When\" is when they converted, else their first outreach, else when they were "
                  "assigned. It isn't when they entered their current stage."],
        "notes": [],
    },
    # Phase 2: the Jobs pages ─────────────────────────────────────────────────
    # routes/jobs.py list_contacts (JobsContacts).
    "contacts": {
        "title": "Contacts",
        "who": ("Jobs prospects: every contact flagged as a Jobs contact, at any pipeline stage or none. "
                "\"All contacts\" lists everyone on file. The Owner filter and column are the contact's "
                "owner, not the pipeline's."),
        "order": "By name; click a column to sort by it.",
        "cap": ("Jobs prospects load in full; All contacts stops at 5,000 and says so. 300 rows show at "
                "first, then Show all."),
        "dates": ["\"Last activity\" is the latest Jobs-related activity linked to the contact, by anyone, "
                  "in either direction, notes included."],
        "notes": [
            "A contact whose pipeline stage was cleared stays a Jobs prospect.",
            "The \"Initial outreach date\" filter is the contact's first activity of any kind, not the day "
            "they moved to Initial Outreach.",
            "Last activity here counts notes and doesn't skip auto-replies, so it can be later than on "
            "Accounts or Pipeline.",
        ],
    },
    # routes/jobs.py jobs_accounts (JobsAccountHub).
    "accounts": {
        "title": "Accounts",
        "who": ("Every company with an opportunity, an account record, or a Jobs contact, folding case and "
                "spacing in the name. Engaged leaves out companies whose only contacts are LinkedIn "
                "imports nobody has worked; it never hides a company with an opportunity or a record."),
        "order": "By status, then by opportunities and contacts, most first, then name.",
        "cap": "All are loaded; 200 show at first, then Show all.",
        "dates": ["\"Last activity\" is the latest email, call, meeting, LinkedIn message or text with anyone "
                  "at the company or on its opportunities, or the newest role or hire recorded there."],
        "notes": [
            "Status: Deprioritized and On Hold come from Salesforce; otherwise an open opportunity is "
            "Pursuing, a won one Stewarding, an older one Re-activating (touched in 90 days) or Dormant, "
            "activity or a flagged contact Activating, and the rest Prospect.",
            "\"Contacts\" counts engaged Jobs contacts, not everyone on file at the company.",
            "Search matches the company name and opportunity titles, not contacts.",
        ],
    },
    # routes/jobs.py list_opportunities (JobsTeam on /jobs/pipeline).
    "pipeline_table": {
        "title": "Pipeline",
        "who": "Every opportunity not deleted, in every stage: closed won, closed lost and on hold included.",
        "order": "Highest priority first (P1), then most recently updated; click a column to sort by it.",
        "cap": "None.",
        "dates": [
            "\"Target close\" is the date the owner expects it to close.",
            "\"N in 7 days\" beside a company is activity in the last 7 days, not this calendar week.",
        ],
        "notes": ["Activity counts what's logged on the opportunity, with its contacts (or anyone at the "
                  "account when none are linked), or on its Salesforce account."],
    },
    # routes/jobs.py roles_board (RolesBoard).
    "roles_pursuit_supported": {
        "title": "Pursuit-Supported roles",
        "who": ("Every role on an opportunity that isn't deleted, except roles marked builder-sourced and "
                "full-time roles already filled. Cancelled roles show as Closed. Under each role, every "
                "application to it."),
        "order": ("Roles nobody has placed by dragging come first, newest-updated first; then the dragged "
                  "order; cancelled roles last. Applications newest first."),
        "cap": "None.",
        "dates": ["The date beside an application is when it was last edited, not when it was made."],
        "notes": ["The opportunity's stage isn't checked, so a role on a closed-lost or on-hold opportunity "
                  "still shows."],
    },
    # routes/jobs.py staff-sourced job applications.
    "roles_staff_sourced": {
        "title": "Staff-Sourced roles",
        "who": ("Applications Pursuit referred or staff sourced in the last 30 days that aren't attached "
                "to a role, grouped by company and role title. Test rows are left out."),
        "order": "Newest application first; within a group, interview, offer and accepted first.",
        "cap": "None.",
        "dates": ["The date beside an application is when it was last edited; the 30 days count from when "
                  "it was made."],
        "notes": ["Dismiss hides a group in your browser only; teammates still see it.",
                  "The number beside the heading counts applications, not groups."],
    },
    # routes/jobs.py builder-sourced job applications.
    "roles_builder_sourced": {
        "title": "Builder-Sourced roles",
        "who": ("Applications builders found themselves in the last 30 days that aren't attached to a "
                "role, plus every role marked builder-sourced, whatever its date (not filled full-time, "
                "not on a deleted opportunity)."),
        "order": ("Interview, offer and accepted first, then newest application; a marked role with no "
                  "application sorts to the top of the rest."),
        "cap": "None.",
        "dates": ["The date in an expanded row is when the application was last edited."],
        "notes": ["\"Last 30 days\" doesn't apply to roles marked builder-sourced.",
                  "Dismiss hides a row in your browser only."],
    },
    # routes/jobs.py builders board (JobsBuilders).
    "builders_board": {
        "title": "Builders",
        "who": ("Every builder enrolled in an L3 or L3+ course, plus the rest of the job-ready pool (such "
                "as builders later hired as staff)."),
        "order": "By status: actively applying, interviewing, paid work, placed, paused, not started.",
        "cap": "None.",
        "dates": [],
        "notes": [
            "Status is a coach's override, else: placed (full-time or a paid trial), paid work, "
            "interviewing (a Pursuit-referred application at interview now), actively applying (in job "
            "strategy, or a Pursuit-referred application in the last 60 days), otherwise not started.",
            "Apps and Interviews count only Pursuit-referred applications; staff-sourced and the "
            "builder's own aren't in them, and an offer or a hire isn't counted as an interview.",
        ],
    },
    # routes/jobs.py my_network (JobsMyNetwork).
    "my_network": {
        "title": "My Network",
        "who": ("Your LinkedIn connections (merged contacts left out). Pursuit Network, for executives and "
                "admins, is every contact with a curated tag other than alumni and influence."),
        "order": ("P1 first, then P2, then the rest; within each, people you've been in touch with, then "
                  "people anyone has, then the most recent contact. Clicking a column sorts within the "
                  "bands."),
        "cap": "The first 2,000 load, and the list says when there are more; 25 show at first.",
        "dates": [],
        "notes": [
            "P1: highest seniority at a company of 11 to 5,000 people, a portfolio company with two fits, "
            "or all three fits (51 to 200 people, tri-state HQ or unknown, high seniority). P2: a "
            "portfolio company, two fits, or a Work now account. Pursuit's own staff and alumni are "
            "left out.",
            "Your \"Expect a response\" and \"Hiring fit\" ratings are saved for you alone, and only this "
            "page reads them: they fill those columns and their filters and sorts. They don't change "
            "the order, the P1 and P2 bands, or any other page.",
            "Warm means you sent or logged activity with them; touched means anyone at Pursuit did.",
        ],
    },
    # routes/jobs.py list_candidates; services/candidate_pipeline.py.
    "candidates": {
        "title": "Candidates to review",
        "who": ("People who emailed or met someone at Pursuit whose mailbox syncs, and who weren't "
                "contacts yet. One becomes a candidate if they're warm: in touch in the last 90 days, or "
                "three or more messages. Shown for the owner picked: the staff on those messages."),
        "order": "Candidates with company details first, then the most recent activity.",
        "cap": "20 show at first, then Show all.",
        "dates": [],
        "notes": [
            "The nightly sync looks at every synced mailbox, not only Jobs email, so a candidate may not "
            "be a hiring contact. Builders are dismissed automatically when their email or name matches.",
            "A candidate's owners are set when they're first found; later emails from someone else don't "
            "add them.",
            "\"N emails\" counts meetings too. Dismissing a candidate hides them for everyone.",
        ],
    },
}

FIELDS =("title", "who", "order", "cap", "dates", "notes")


def why(key: str) -> Optional[dict]:
    """How one list picks its rows, or None for a list without words yet."""
    entry = LISTS.get(key)
    return {"key": key, **entry} if entry else None
