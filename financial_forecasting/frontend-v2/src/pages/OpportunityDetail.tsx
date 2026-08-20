import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ExternalLink, Info, Plus } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { OpportunityDeliverablesSection } from "@/components/OpportunityDeliverablesSection";
import { OppTasksSection } from "@/components/OppTasksSection";
import { OpportunityFilesSection, OpportunityFilesUploadAction } from "@/components/OpportunityFilesSection";
import { PaymentScheduleBuilder } from "@/components/PaymentScheduleBuilder";
import { AwardSetupDialog } from "@/components/AwardSetupDialog";
import { StageGateDialog } from "@/components/StageGateDialog";
import { StageProgression } from "@/components/StageProgression";
import {
  BackLink as SharedBackLink,
  EditField,
  Empty,
  LinkedProjectsCard,
  SectionCard,
} from "@/components/detail";
import { AccountPicker } from "@/components/ui/AccountPicker";
import { ContactPicker } from "@/components/ui/ContactPicker";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import { getStageGate } from "@/lib/stageGates";
import { useProbabilityScheduleGate } from "@/lib/useProbabilityScheduleGate";
import { useStageChangeGate } from "@/lib/useStageChangeGate";
import { SF_STAGE_OPTIONS, stageStatus } from "@/lib/stages";
import { cn } from "@/lib/utils";
import {
  useAccountEnrichment,
  useAccounts,
  useCreateAccount,
} from "@/services/accounts";
import { useActivities } from "@/services/activities";
import { useAwards } from "@/services/awards";
import { useContacts, useCreateContact } from "@/services/contacts";
import {
  useOpportunities,
  useOpportunityPayments,
  useOpportunityStageHistory,
  useUpdateOpportunity,
  useUpdateOpportunityStage,
} from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";

/** Filter values for the Payments section pill toggle. */
type PaymentFilter = "all" | "open" | "paid";

export function OpportunityDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();

  const { data: opps } = useOpportunities();
  const opp = useMemo(
    () => (opps ?? []).find((o) => o.Id === id),
    [opps, id],
  );

  const { data: payments = [] } = useOpportunityPayments(id);
  const { data: activities = [] } = useActivities({ opportunityId: id, limit: 30 });
  const { data: awards = [] } = useAwards();
  const stageHistory = useOpportunityStageHistory(id);
  const enrichment = useAccountEnrichment(opp?.AccountId ?? null);
  // Full contact list — feeds the inline Contact picker. Org has
  // ~10K contacts; we filter client-side as the user types.
  const { data: contactsData = [] } = useContacts();
  // Full account list — feeds the inline Account picker (search-based,
  // since the org has 20K accounts and a `<select>` would jank).
  const { data: accountsData = [] } = useAccounts();
  const usersQ = useActiveUsers();

  const updateOpp = useUpdateOpportunity();
  const updateStage = useUpdateOpportunityStage();
  const stageGate = useStageChangeGate();
  const probGate = useProbabilityScheduleGate();
  const createAccount = useCreateAccount();
  const createContact = useCreateContact();

  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  // Stage options are the curated 7 from SF_STAGE_OPTIONS. If the
  // current opp is in a non-canonical / legacy stage, include it as
  // the selected display value so the dropdown still renders correctly
  // — but only the 7 canonical values are selectable for new edits.
  const stageOptions = useMemo(() => {
    const out = SF_STAGE_OPTIONS.map((s) => ({ value: s.value, label: s.label }));
    if (
      opp?.StageName &&
      !SF_STAGE_OPTIONS.some((s) => s.value === opp.StageName)
    ) {
      out.unshift({
        value: opp.StageName,
        label: `${opp.StageName} (legacy)`,
      });
    }
    return out;
  }, [opp?.StageName]);

  const accountOptions = useMemo(
    () =>
      accountsData
        .map((a) => ({ value: a.Id, label: a.Name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [accountsData],
  );

  // Build display labels for the contact picker — show name + parent
  // account as the muted detail line so similarly-named contacts are
  // disambiguated at a glance.
  const contactOptions = useMemo(
    () =>
      contactsData
        .map((c) => {
          const composed =
            c.Name ?? [c.FirstName, c.LastName].filter(Boolean).join(" ").trim();
          return {
            value: c.Id,
            label: composed || c.Id,
            detail: c.Account?.Name ?? c.Email ?? undefined,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    [contactsData],
  );

  // Whether to show the payment-schedule modal — controlled at the
  // page level so the action button on the Payments section can open
  // it and the modal can dismiss back to the page cleanly.
  // Also auto-opens when a stage change triggers award creation, or
  // when the backend requires a schedule before allowing the stage change.
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [pendingStage, setPendingStage] = useState<string | null>(null);
  // Controlled locally so check/uncheck is instant — not derived from opp data
  // which would lag by one SF round-trip.
  const [showGrantDates, setShowGrantDates] = useState(() => !!(opp?.Grant_Start_Date__c));

  // Sync when navigating to a different opportunity (opp.Id changes).
  // Deliberately NOT keyed on Grant_Start_Date__c so user's explicit
  // uncheck isn't overwritten while the SF clear is in-flight.
  useEffect(() => {
    setShowGrantDates(!!(opp?.Grant_Start_Date__c));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opp?.Id]);

  const handleStageChange = async (newStage: string) => {
    // First: does the playbook require a gate for this transition?
    // Withdrawn / Closed Lost ask for close reason; Ask-in-progress
    // exit and Proposal → Contracting ask for the full checklist;
    // Contracting → Collecting asks for the signed contract.
    const spec = opp ? getStageGate(opp.StageName, newStage) : null;
    if (spec) {
      stageGate.request(opp!, newStage);
      return;
    }

    // Legacy fallback: Collecting / In Effect from anywhere *other
    // than* Contracting (e.g. someone skipping straight from Proposal
    // Submitted) still needs the payment-schedule modal. Once every
    // path has a gate, this branch will be dead.
    if (newStage === "Collecting / In Effect") {
      setPendingStage(newStage);
      setScheduleModalOpen(true);
      return;
    }

    const result = await updateStage.mutateAsync({ id, newStage });
    if (result?.award_created) {
      setScheduleModalOpen(true);
    }
  };

  const award = useMemo(
    () => awards.find((a) => a.opportunity_id === id) ?? null,
    [awards, id],
  );

  if (!opp) {
    return (
      <div className="mx-auto max-w-[1320px] px-7 py-6">
        <BackLink />
        <div className="mt-6 rounded-lg border border-border-strong bg-surface p-10 text-center text-[13px] text-ink-3 shadow-sm">
          Loading opportunity…
        </div>
      </div>
    );
  }

  const patch = (field: string, val: unknown): Promise<void> =>
    updateOpp.mutateAsync({ id: opp.Id, patch: { [field]: val } }).then(() => undefined);

  const hasGrantDates = !!(opp.Grant_Start_Date__c);
  const grantDateError =
    opp.Grant_Start_Date__c && !opp.Grant_End_Date__c
      ? "Grant end date is also required."
      : !opp.Grant_Start_Date__c && opp.Grant_End_Date__c
        ? "Grant start date is also required."
        : null;

  const saveOwner = async (ownerId: string) => {
    const ownerName = (usersQ.data ?? []).find((u) => u.Id === ownerId)?.Name ?? null;
    await updateOpp.mutateAsync({
      id: opp.Id,
      patch: { OwnerId: ownerId },
      displayPatch: { Owner: { Name: ownerName } },
    });
  };

  // Used by PaymentsSection for its default-open heuristic — open when
  // there's an unpaid balance, closed once everything is paid.
  const totalScheduled = payments
    .filter((p) => !p.npe01__Paid__c && !p.npe01__Written_Off__c)
    .reduce((s, p) => s + (p.npe01__Payment_Amount__c ?? 0), 0);

  // Referrer for cross-detail jumps (account, contact, award) — when
  // the user clicks one of those, the BackLink there should return
  // here, not to /accounts. {@link DetailReferrer}.
  const referrer = {
    from: { pathname: location.pathname, label: opp.Name ?? "Opportunity" },
  };

  return (
    <div className="mx-auto max-w-[1320px] px-7 py-6 pb-20">
      <BackLink />

      {/* Header */}
      <div className="mt-4 flex items-start gap-4">
        <AccountAvatar
          name={opp.Account?.Name ?? opp.Name}
          logoUrl={enrichment.data?.logo_url ?? null}
          website={null}
          size={48}
        />
        <div className="flex-1 min-w-0">
          <InlineText
            value={opp.Name}
            onSave={(v) => patch("Name", v)}
            className="text-[24px] font-bold leading-tight tracking-tight text-ink py-0"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            <InlineSelect
              value={opp.StageName}
              options={stageOptions}
              onSave={handleStageChange}
              renderValue={(v) => <StageChip stage={v ?? opp.StageName} status={stageStatus({ ...opp, StageName: v ?? opp.StageName })} />}
            />
            <InlineSelect
              value={opp.Priority__c ?? ""}
              options={PRIORITY_OPTIONS}
              onSave={(v) => patch("Priority__c", v || null)}
              renderValue={(v) => <PriorityTag value={v ?? opp.Priority__c ?? null} />}
            />
            {opp.RecordType?.Name ? <Tag>{opp.RecordType.Name}</Tag> : null}
            {opp.AccountId ? (
              <Link
                to={`/accounts/${opp.AccountId}`}
                state={referrer}
                className="underline-offset-4 hover:underline"
              >
                · {opp.Account?.Name ?? opp.AccountId}
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {/* Stage progression — visualizes the funnel and time-in-stage. */}
      <StageProgression
        currentStage={opp.StageName}
        createdDate={opp.CreatedDate ?? null}
        closeDate={opp.CloseDate ?? null}
        isClosed={opp.IsClosed === true}
        history={stageHistory.data ?? []}
      />

      {/* Details — always-on canonical fields */}
      <SectionCard title="Details" collapsible={false} storageScope="opportunity">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 md:grid-cols-3">
          {/* Top row: the three the user updates most often.
              formatDisplay shows currency/percent in resting state but
              the editor input still operates on raw digits. */}
          <EditField label="Amount">
            <InlineText
              value={opp.Amount != null ? String(opp.Amount) : ""}
              onSave={(v) => patch("Amount", v ? Number(v.replace(/[^0-9.]/g, "")) : null)}
              formatDisplay={formatMoneyDisplay}
              placeholder="—"
            />
          </EditField>
          <EditField label="Close date">
            <InlineDate
              value={opp.CloseDate}
              onSave={(v) => patch("CloseDate", v)}
            />
          </EditField>
          <EditField label="Probability">
            <InlineText
              value={opp.Manager_Probability_Override__c != null ? String(opp.Manager_Probability_Override__c) : (opp.Probability != null ? String(opp.Probability) : "")}
              onSave={async (v) => {
                // Mirror SF's UI behavior: write Probability alongside
                // Manager_Probability_Override__c so the two stay in sync.
                // Clearing the override (null) lets SF restore the
                // stage-driven default — don't touch Probability then.
                const next = v ? Number(v) : null;
                // Playbook gate: 0 → >0 requires a payment schedule.
                await probGate.request(opp, next);
                const body: Record<string, unknown> = { Manager_Probability_Override__c: next };
                if (next != null) body.Probability = next;
                await updateOpp.mutateAsync({ id: opp.Id, patch: body });
              }}
              formatDisplay={formatPercentDisplay}
              placeholder="—"
            />
          </EditField>

          {/* Second row: ownership + relationships. */}
          <EditField label="Owner">
            <InlineSelect
              value={opp.OwnerId ?? null}
              options={ownerOptions}
              onSave={saveOwner}
              renderValue={() => (
                <span className="text-[13px] text-ink-2">
                  {opp.Owner?.Name ?? ownerOptions.find((o) => o.value === opp.OwnerId)?.label ?? "—"}
                </span>
              )}
            />
          </EditField>
          <EditField label="Account">
            <AccountPicker
              value={opp.AccountId ?? null}
              currentLabel={opp.Account?.Name ?? null}
              options={accountOptions}
              onSave={(accountId) =>
                updateOpp
                  .mutateAsync({
                    id: opp.Id,
                    patch: { AccountId: accountId },
                    displayPatch: {
                      Account: {
                        Name: accountOptions.find((o) => o.value === accountId)?.label ?? "",
                      },
                    } as Record<string, unknown>,
                  })
                  .then(() => undefined)
              }
              onCreateNew={async (name) => {
                const result = await createAccount.mutateAsync({ Name: name });
                return result.id;
              }}
            />
          </EditField>
          <EditField label="Primary contact">
            <ContactPicker
              value={opp.npsp__Primary_Contact__c ?? null}
              currentLabel={opp.npsp__Primary_Contact__r?.Name ?? null}
              options={contactOptions}
              onSave={(contactId) => patch("npsp__Primary_Contact__c", contactId)}
              onCreateNew={async (raw) => {
                const trimmed = raw.trim();
                const lastSpace = trimmed.lastIndexOf(" ");
                const firstName =
                  lastSpace > 0 ? trimmed.slice(0, lastSpace).trim() : undefined;
                const lastName =
                  lastSpace > 0 ? trimmed.slice(lastSpace + 1).trim() : trimmed;
                if (!opp.AccountId) {
                  throw new Error(
                    "Set an account on this opportunity first — contacts require an Account.",
                  );
                }
                const result = await createContact.mutateAsync({
                  AccountId: opp.AccountId,
                  FirstName: firstName,
                  LastName: lastName,
                });
                return result.id;
              }}
            />
          </EditField>

          {/* Third row: payment + ask + stage (also live in header). */}
          <EditField label="1st payment">
            <InlineDate
              value={opp.PaymentDate__c}
              onSave={(v) => patch("PaymentDate__c", v)}
            />
          </EditField>
          <EditField label="Ask amount">
            <InlineText
              value={
                opp.Ask_Amount_if_different_from_actual__c != null
                  ? String(opp.Ask_Amount_if_different_from_actual__c)
                  : ""
              }
              onSave={(v) =>
                patch(
                  "Ask_Amount_if_different_from_actual__c",
                  v ? Number(v.replace(/[^0-9.]/g, "")) : null,
                )
              }
              formatDisplay={formatMoneyDisplay}
              placeholder="—"
            />
          </EditField>
          <EditField label="Stage">
            <InlineSelect
              value={opp.StageName}
              options={stageOptions}
              onSave={handleStageChange}
              renderValue={(v) => <StageChip stage={v ?? opp.StageName} status={stageStatus({ ...opp, StageName: v ?? opp.StageName })} />}
            />
          </EditField>

          {/* Multi-year grant — full-width row below the 3-column grid */}
          <div className="col-span-full mt-1 border-t border-border pt-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="multi-year-grant"
                checked={showGrantDates}
                onChange={(e) => {
                  if (e.target.checked) {
                    setShowGrantDates(true);
                  } else {
                    setShowGrantDates(false);
                    if (hasGrantDates) {
                      void patch("Grant_Start_Date__c", null);
                      void patch("Grant_End_Date__c", null);
                    }
                  }
                }}
                className="h-3.5 w-3.5 cursor-pointer rounded border-border-strong accent-accent"
              />
              <label
                htmlFor="multi-year-grant"
                className="cursor-pointer select-none text-[13px] font-medium text-ink"
              >
                Enter Grant Period?
              </label>
              <Tooltip
                content="If this grant spans multiple years, enter start and end dates that encapsulate the full period within which the funds will be disbursed."
                side="right"
              >
                <Info size={13} className="cursor-help text-ink-3" />
              </Tooltip>
            </div>

            {showGrantDates ? (
              <div className="flex flex-wrap items-start gap-6 pl-5">
                <EditField label="Grant start date">
                  <InlineDate
                    value={opp.Grant_Start_Date__c ?? null}
                    onSave={(v) => {
                      void patch("Grant_Start_Date__c", v);
                    }}
                  />
                </EditField>
                <EditField label="Grant end date">
                  <InlineDate
                    value={opp.Grant_End_Date__c ?? null}
                    onSave={(v) => {
                      void patch("Grant_End_Date__c", v);
                    }}
                  />
                </EditField>
                {grantDateError ? (
                  <p className="col-span-full text-[12px] text-red">{grantDateError}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </SectionCard>

      {/* Deliverables — SF npsp__Grant_Deadline__c records */}
      <OpportunityDeliverablesSection opportunityId={opp.Id} />

      {/* Files — SF ContentDocumentLink records */}
      <SectionCard
        title="Files"
        action={<OpportunityFilesUploadAction opportunityId={opp.Id} />}
      >
        <OpportunityFilesSection opportunityId={opp.Id} />
      </SectionCard>

      {/* Tasks */}
      <OppTasksSection opportunityId={opp.Id} />

      {/* Payments — pill-toggle filter (All / Open / Paid). Default-open
          when there's an unpaid balance, default-closed once everything
          is paid (no action needed). The "Schedule" action opens the
          builder modal — replaces existing payments by default. */}
      <PaymentsSection
        payments={payments}
        defaultOpen={totalScheduled > 0 || payments.length === 0}
        onSchedule={() => setScheduleModalOpen(true)}
      />

      {scheduleModalOpen ? (
        <PaymentScheduleBuilder
          opportunityId={opp.Id}
          oppAmount={opp.Amount ?? null}
          existingPayments={payments}
          initialFirstDate={opp.PaymentDate__c ?? null}
          prompt={
            pendingStage
              ? `Review and confirm the payment schedule below. Once saved, the stage will move to "${pendingStage}" and the award record will be created.`
              : null
          }
          onSaved={
            pendingStage
              ? () => {
                  const stage = pendingStage;
                  setPendingStage(null);
                  void updateStage.mutateAsync({ id, newStage: stage }).then((result) => {
                    if (result?.award_created) {
                      // Award was created — modal is already closing, nothing extra needed
                    }
                  });
                }
              : undefined
          }
          onClose={() => {
            setScheduleModalOpen(false);
            setPendingStage(null);
          }}
        />
      ) : null}

      {stageGate.pending ? (
        <StageGateDialog
          spec={stageGate.pending.spec}
          opp={stageGate.pending.opp}
          toStage={stageGate.pending.toStage}
          onClose={stageGate.dismiss}
          onCompleted={stageGate.complete}
          onAwardCreated={stageGate.openAwardSetup}
        />
      ) : null}

      {stageGate.awardSetup ? (
        <AwardSetupDialog
          awardId={stageGate.awardSetup.awardId}
          opportunityId={stageGate.awardSetup.opportunityId}
          onClose={stageGate.dismissAwardSetup}
        />
      ) : null}

      {probGate.pending ? (
        <PaymentScheduleBuilder
          opportunityId={probGate.pending.opp.Id}
          oppAmount={probGate.pending.opp.Amount ?? null}
          existingPayments={payments}
          initialFirstDate={probGate.pending.opp.CloseDate ?? null}
          prompt={`Raising probability to ${probGate.pending.nextProbability}% — set the expected payment schedule before continuing.`}
          onClose={probGate.dismiss}
          onSaved={probGate.complete}
        />
      ) : null}

      {/* Award — only when this opp produced an award. */}
      {award ? (
        <SectionCard
          title="Award"
          storageScope="opportunity"
          action={
            <Link
              to={`/awards/${award.id}`}
              state={referrer}
              className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
            >
              <ExternalLink size={11} aria-hidden="true" /> Open
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 md:grid-cols-4">
            <EditField label="Status">
              <Tag
                variant={
                  award.award_status === "Active"
                    ? "green"
                    : award.award_status === "Closing"
                      ? "amber"
                      : award.award_status === "Did Not Fulfill"
                        ? "red"
                        : "default"
                }
              >
                {award.award_status}
              </Tag>
            </EditField>
            <EditField label="Awarded">
              <span className="px-1.5 py-1 text-[13px] text-ink-2">{fmtDate(award.award_date)}</span>
            </EditField>
            <EditField label="Period end">
              <span className="px-1.5 py-1 text-[13px] text-ink-2">{fmtDate(award.period_end_date)}</span>
            </EditField>
            <EditField label="Reports">
              <span className="px-1.5 py-1 text-[13px] text-ink-2">
                {award.report_done}/{award.report_total}
                {award.report_overdue > 0 ? (
                  <span className="ml-1 text-red"> · {award.report_overdue} overdue</span>
                ) : null}
              </span>
            </EditField>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Linked projects" storageScope="opportunity">
        <div className="px-5 py-4">
          <LinkedProjectsCard
            entityType="opportunity"
            entityId={opp.Id}
            referrerLabel="Opportunity"
          />
        </div>
      </SectionCard>

      {/* Activity timeline — scoped so search/filter state is per-entity. */}
      <ActivityTimeline activities={activities} scopeKey={`opportunity:${opp.Id}`} />

      <p className="mt-6 text-[11px] text-ink-4">
        SF Id: <span className="mono">{opp.Id}</span>
      </p>
    </div>
  );
}

// ── Payments ─────────────────────────────────────────────────────────────

interface PaymentLite {
  Id: string;
  npe01__Paid__c?: boolean | null;
  npe01__Written_Off__c?: boolean | null;
  Delinquent__c?: boolean | null;
  Payment_Status__c?: string | null;
  npe01__Payment_Amount__c?: number | null;
  npe01__Payment_Method__c?: string | null;
  npe01__Scheduled_Date__c?: string | null;
  npe01__Payment_Date__c?: string | null;
}

function PaymentsSection({
  payments,
  defaultOpen,
  onSchedule,
}: {
  payments: PaymentLite[];
  defaultOpen: boolean;
  onSchedule: () => void;
}) {
  const [filter, setFilter] = useState<PaymentFilter>("all");

  const counts = useMemo(() => {
    let open = 0;
    let paid = 0;
    for (const p of payments) {
      if (p.npe01__Paid__c) paid += 1;
      else if (!p.npe01__Written_Off__c) open += 1;
    }
    return { all: payments.length, open, paid };
  }, [payments]);

  const filtered = useMemo(() => {
    if (filter === "all") return payments;
    if (filter === "open") {
      return payments.filter((p) => !p.npe01__Paid__c && !p.npe01__Written_Off__c);
    }
    return payments.filter((p) => p.npe01__Paid__c);
  }, [payments, filter]);

  return (
    <SectionCard
      title={`Payments (${payments.length})`}
      storageScope="opportunity"
      defaultOpen={defaultOpen}
      action={
        <div className="flex items-center gap-2">
          <PaymentFilterPill
            counts={counts}
            value={filter}
            onChange={setFilter}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSchedule();
            }}
            className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
            title={
              payments.length > 0
                ? `Replace the existing ${payments.length} payment${payments.length === 1 ? "" : "s"}`
                : "Generate a payment schedule"
            }
          >
            <Plus size={11} aria-hidden="true" />
            {payments.length > 0 ? "Replace schedule" : "Schedule"}
          </button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <Empty>
          {payments.length === 0 ? "No payment schedule." : `No ${filter} payments.`}
        </Empty>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Scheduled", "Amount", "Status", "Method", "Received", "Notes"].map(
                (h, i) => (
                  <th
                    key={h}
                    className={cn(
                      "border-b border-border-strong bg-surface-2 px-5 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3",
                      i === 1 ? "text-right" : "text-left",
                    )}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const status = paymentStatus(p);
              return (
                <tr
                  key={p.Id}
                  className="border-b border-border-strong last:border-b-0"
                >
                  <td className="mono px-5 py-2.5 text-[12.5px] text-ink-2">
                    {fmtDate(p.npe01__Scheduled_Date__c)}
                  </td>
                  <td className="mono px-5 py-2.5 text-right text-[13px] font-medium tabular-nums">
                    {p.npe01__Payment_Amount__c
                      ? fmtMoneyFull(p.npe01__Payment_Amount__c, true)
                      : "—"}
                  </td>
                  <td className="px-5 py-2.5">
                    <Tag variant={status.variant}>{status.label}</Tag>
                  </td>
                  <td className="px-5 py-2.5 text-[12px] text-ink-2">
                    {p.npe01__Payment_Method__c ?? "—"}
                  </td>
                  <td className="mono px-5 py-2.5 text-[11.5px] text-ink-3">
                    {fmtDate(p.npe01__Payment_Date__c)}
                  </td>
                  <td className="px-5 py-2.5 text-[12px] text-ink-3">
                    {p.npe01__Written_Off__c ? "Written off" : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

function PaymentFilterPill({
  counts,
  value,
  onChange,
}: {
  counts: { all: number; open: number; paid: number };
  value: PaymentFilter;
  onChange: (v: PaymentFilter) => void;
}) {
  const opts: { value: PaymentFilter; label: string; count: number }[] = [
    { value: "open", label: "Open", count: counts.open },
    { value: "paid", label: "Paid", count: counts.paid },
    { value: "all", label: "All", count: counts.all },
  ];
  return (
    <div
      className="inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5"
      role="tablist"
      aria-label="Filter payments"
    >
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={(e) => {
            e.stopPropagation();
            onChange(o.value);
          }}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
            value === o.value
              ? "bg-ink text-surface"
              : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label} <span className="opacity-60">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

// ── Primary contact picker ───────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────────

function paymentStatus(p: PaymentLite): {
  label: string;
  variant: "green" | "amber" | "red" | "default";
} {
  if (p.npe01__Paid__c) return { label: "Paid", variant: "green" };
  if (p.npe01__Written_Off__c) return { label: "Written off", variant: "default" };
  if (p.Delinquent__c) return { label: "Overdue", variant: "red" };
  if (p.Payment_Status__c) return { label: p.Payment_Status__c, variant: "amber" };
  return { label: "Scheduled", variant: "amber" };
}

function BackLink() {
  return <SharedBackLink defaultTo="/pipeline" defaultLabel="Pipeline" />;
}

/** Currency display for inline-edit fields — "$5,000" in resting state.
 *  Strips non-numeric junk before formatting so a stored "5000.00" still
 *  renders cleanly. Returns the raw string when it can't be parsed so
 *  the user sees what's actually there instead of a misleading "$0". */
function formatMoneyDisplay(raw: string): string {
  const n = Number(raw.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return raw;
  return fmtMoneyFull(n);
}

/** Percent display — "20%" in resting state. */
function formatPercentDisplay(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return `${n}%`;
}

/** Priority picklist surfaced in the OpportunityDetail header. SF picklist
 *  on Opportunity.Priority__c — values Low / Medium / High. Empty option
 *  lets editors clear the value. */
const PRIORITY_OPTIONS = [
  { value: "", label: "—" },
  { value: "High", label: "High" },
  { value: "Medium", label: "Medium" },
  { value: "Low", label: "Low" },
];

function PriorityTag({ value }: { value: string | null }) {
  if (!value) {
    return <Tag>Priority —</Tag>;
  }
  const cls =
    value === "High"
      ? "border-red bg-red-soft text-red"
      : value === "Medium"
      ? "border-amber bg-amber-soft text-amber"
      : "border-border-strong bg-surface-2 text-ink-3";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium",
        cls,
      )}
    >
      Priority: {value}
    </span>
  );
}
