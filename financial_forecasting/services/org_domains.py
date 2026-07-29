"""Pursuit-owned email domains, past and present.

The org has operated under several domains over its 15-year history
(Coalition for Queens → C4Q → Pursuit). Mail among any of these addresses is
internal staff mail, not external contact activity — matching only
"@pursuit.org" made historical C4Q-era threads look like external contacts.
scripts/scan_activity_universe.py carries the same set; keep them in sync.
"""

INTERNAL_EMAIL_DOMAINS = {
    "pursuit.org",
    "pursuit.com",
    "coalitionforqueens.org",
    "c4q.nyc",
    "ac.c4q.nyc",
}


def is_internal_email(email: str) -> bool:
    """True if the address belongs to a Pursuit-owned domain (any era).

    Accepts bare addresses or "Name <addr>" forms; matches exact domains and
    their subdomains (e.g. mail.c4q.nyc under c4q.nyc).
    """
    addr = (email or "").strip().lower()
    if "<" in addr:
        addr = addr.split("<")[-1].strip("> ")
    domain = addr.rsplit("@", 1)[-1] if "@" in addr else ""
    if domain in INTERNAL_EMAIL_DOMAINS:
        return True
    return any(domain.endswith("." + d) for d in INTERNAL_EMAIL_DOMAINS)
