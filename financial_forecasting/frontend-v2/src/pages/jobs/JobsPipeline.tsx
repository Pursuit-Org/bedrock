import { PageHeader } from "@/components/PageHeader";
import { JobsTeam } from "./JobsTeam";

export function JobsPipelinePage() {
  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title="Pipeline"
        subtitle="Every employer opportunity, stage, and owner."
      />
      <JobsTeam />
    </div>
  );
}
