import { Navigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { JobsHome } from "./jobs/JobsHome";

/**
 * /jobs — the Jobs Home page.
 *
 * Before the 2026-07 nav restructure every jobs view was tab state on this one
 * route, addressed as /jobs?view=... — those links live on in bookmarks and
 * Slack, so map them to the routed pages and redirect. Unknown or absent
 * ?view= falls through to Home.
 */
function legacyJobsRedirect(params: URLSearchParams): string | null {
  const view = params.get("view");
  if (!view) return null;
  switch (view) {
    case "performance":
      return "/jobs/performance";
    case "outreach":
      return "/jobs/performance?tab=outreach";
    // "team" and "overview" were historical aliases for the opportunities view;
    // ?opps=set picked the editable deal list, otherwise the read-only overview.
    case "opportunities":
    case "team":
    case "overview":
      return params.get("opps") === "set" ? "/jobs/pipeline" : "/jobs/performance?tab=pipeline";
    case "builders":
      return "/jobs/placement?tab=builders";
    case "contacts": {
      const next = new URLSearchParams();
      const q = params.get("q");
      const contact = params.get("contact");
      if (q) next.set("q", q);
      if (contact) next.set("contact", contact);
      const qs = next.toString();
      return qs ? `/jobs/contacts?${qs}` : "/jobs/contacts";
    }
    case "accounts": {
      const q = params.get("q");
      return q ? `/jobs/accounts?q=${encodeURIComponent(q)}` : "/jobs/accounts";
    }
    default:
      return null;
  }
}

export function JobsPage() {
  const [searchParams] = useSearchParams();
  const redirect = legacyJobsRedirect(searchParams);
  if (redirect) return <Navigate to={redirect} replace />;

  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title="Jobs"
        subtitle="Daily command center — tasks, interviews, and triage."
      />
      <JobsHome />
    </div>
  );
}
