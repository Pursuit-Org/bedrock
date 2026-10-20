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
}

FIELDS = ("title", "who", "order", "cap", "dates", "notes")


def why(key: str) -> Optional[dict]:
    """How one list picks its rows, or None for a list without words yet."""
    entry = LISTS.get(key)
    return {"key": key, **entry} if entry else None
