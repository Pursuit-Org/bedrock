/**
 * Payments page (/payments).
 *
 * Mirror of the Pipeline page but for npe01__OppPayment__c records:
 *   - virtualized table, resizable + sortable + drag-to-reorder columns
 *   - chip-style filter rig (same `pages/cleanup/Filters` rig used by
 *     Pipeline / Cleanup tabs)
 *   - inline edits on every editable column (amount, scheduled date,
 *     payment date, paid flag, method, written off, department, GL,
 *     reconciled flag)
 *   - SavedViewsPicker (scopeKey="payments") so users can persist
 *     custom views — e.g. "scheduled after current quarter" to mirror
 *     Angie's SF report
 *   - CSV export of the currently-filtered set
 *
 * Read path: usePayments() → /api/salesforce/payments.
 * Write path: useUpdateAnyPayment() → PUT /api/salesforce/payments/{id}.
 *
 * Opp-side fields (owner, stage, opp amount, manager probability,
 * close date, record type, active flag) are SELECTed via the
 * npe01__Opportunity__r relationship — no extra round-trips. See
 * PAYMENT_SOQL_FIELDS in main.py.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AccountAvatar } from "@/components/AccountAvatar";
import { OpportunityExpandPanel, OPP_PANEL_HEIGHT } from "@/components/OpportunityExpandPanel";
import { ExportCsvButton } from "@/components/ui/ExportCsvButton";
import { PageHeader } from "@/components/PageHeader";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { StageChip } from "@/components/ui/StageChip";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import type { CsvColumn } from "@/lib/csv";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { fmtDate, fmtMoney, fmtMoneyFull } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { SF_STAGE_OPTIONS, stageStatus } from "@/lib/stages";
import { cn } from "@/lib/utils";
import {
  usePipelineReviewFlags,
  ruleLabels,
  type PaymentFlags,
} from "@/services/pipelineReview";
import { useSessionState } from "@/lib/useSessionState";
import { useProbabilityScheduleGate } from "@/lib/useProbabilityScheduleGate";
import { useStageChangeGate } from "@/lib/useStageChangeGate";
import { useUpdateOpportunity } from "@/services/opportunities";
import { AwardSetupDialog } from "@/components/AwardSetupDialog";
import { PaymentScheduleBuilder } from "@/components/PaymentScheduleBuilder";
import { StageGateDialog } from "@/components/StageGateDialog";
import type { SfOpportunity } from "@/types/salesforce";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "@/pages/cleanup/Filters";
import { usePerm } from "@/services/permissions";
import {
  usePayments,
  useUpdateAnyPayment,
  type PaymentPatch,
  type SfPayment,
} from "@/services/payments";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Risk-adjusted value = Opp Amount × (manager-probability-override
 *  ?? Probability) / 100. Returns null when amount or probability is
 *  missing — keeps the value column comparable to SF's own
 *  "Expected Revenue" calculation. */
function riskAdjusted(p: SfPayment): number | null {
  const opp = p.npe01__Opportunity__r;
  if (!opp) return null;
  const amt = opp.Amount;
  if (amt == null) return null;
  const prob =
    opp.Manager_Probability_Override__c ?? opp.Probability ?? null;
  if (prob == null) return null;
  return amt * (prob / 100);
}

// ── Scope pills ─────────────────────────────────────────────────────────────

const SCOPES = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "paid", label: "Paid" },
  { value: "writtenOff", label: "Written off" },
  { value: "delinquent", label: "Delinquent" },
] as const;
type Scope = (typeof SCOPES)[number]["value"];

function inScope(p: SfPayment, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === "scheduled") return !p.npe01__Paid__c && !p.npe01__Written_Off__c;
  if (scope === "paid") return Boolean(p.npe01__Paid__c);
  if (scope === "writtenOff") return Boolean(p.npe01__Written_Off__c);
  if (scope === "delinquent") return Boolean(p.Delinquent__c);
  return true;
}

// ── Filter model ────────────────────────────────────────────────────────────

const PAYMENT_METHODS = [
  "ACH", "Benevity", "Cash", "Check", "Credit Card", "Cryptocurrency",
  "Direct Pay", "Loan Forgiveness", "PayPal", "QuickBooks", "Stock",
  "Stripe", "Venmo", "Wire",
];

const DEPARTMENTS = [
  "301--Philanthropy",
  "101--Program",
  "200--Central Processing Unit",
  "402--PBC Business Operations",
];

const GL_ACCOUNTS = [
  "4010--Individual contributions",
  "4020--Corporate contributions",
  "4030--Foundation contributions",
  "4040--Board Contributions",
  "4050--Techbash",
  "4500--Local government grants",
  "4510--State grants",
  "4520--Other Grants",
  "5010--Pursuit Bond",
  "5040--Employment Commitments",
  "7540--Bank fees",
];

const PAYMENT_FILTERABLE = {
  paymentNumber: { label: "Payment #", type: "text", getValue: (p: SfPayment) => p.Name ?? "" },
  opportunity: { label: "Opportunity", type: "text", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Name ?? "" },
  account: { label: "Account", type: "text", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Account?.Name ?? "" },
  oppOwner: { label: "Opp owner", type: "select", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.OwnerId ?? "" },
  stage: { label: "Stage", type: "select", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.StageName ?? "" },
  recordType: { label: "Record type", type: "select", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.RecordType?.Name ?? "" },
  philanthropyType: { label: "Philanthropy type", type: "select", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Philanthropy_Type__c ?? "" },
  active: { label: "Active opportunity", type: "select", getValue: (p: SfPayment) => (p.npe01__Opportunity__r?.Active_Opportunity__c ? "Yes" : "No") },
  oppAmount: { label: "Opp amount", type: "number", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Amount ?? null },
  mgrProb: { label: "Mgr probability", type: "number", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Manager_Probability_Override__c ?? p.npe01__Opportunity__r?.Probability ?? null },
  riskAdjusted: { label: "Risk-adjusted value", type: "number", getValue: (p: SfPayment) => riskAdjusted(p) },
  closeDate: { label: "Close date", type: "date", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.CloseDate ?? null },
  amount: { label: "Payment amount", type: "number", getValue: (p: SfPayment) => p.npe01__Payment_Amount__c ?? null },
  scheduledDate: { label: "Scheduled date", type: "date", getValue: (p: SfPayment) => p.npe01__Scheduled_Date__c ?? null },
  paymentDate: { label: "Payment date", type: "date", getValue: (p: SfPayment) => p.npe01__Payment_Date__c ?? null },
  paid: { label: "Paid", type: "select", getValue: (p: SfPayment) => (p.npe01__Paid__c ? "Yes" : "No") },
  writtenOff: { label: "Written off", type: "select", getValue: (p: SfPayment) => (p.npe01__Written_Off__c ? "Yes" : "No") },
  method: { label: "Method", type: "select", getValue: (p: SfPayment) => p.npe01__Payment_Method__c ?? "" },
  status: { label: "Status", type: "select", getValue: (p: SfPayment) => p.Paid_Status__c ?? p.Payment_Status__c ?? "" },
  delinquent: { label: "Delinquent", type: "select", getValue: (p: SfPayment) => (p.Delinquent__c ? "Yes" : "No") },
  department: { label: "Department", type: "select", getValue: (p: SfPayment) => p.Department__c ?? "" },
  glAccount: { label: "GL account", type: "select", getValue: (p: SfPayment) => p.GL_Account__c ?? "" },
  reconciled: { label: "Reconciled with finance", type: "select", getValue: (p: SfPayment) => (p.Reconciled_with_Finance__c ? "Yes" : "No") },
  amountReceived: { label: "Amount received", type: "number", getValue: (p: SfPayment) => p.Amount_Received__c ?? null },
  amountMinusReceived: { label: "Amount minus received", type: "number", getValue: (p: SfPayment) => p.Amount_Minus_Received__c ?? null },
  createdDate: { label: "Created", type: "date", getValue: (p: SfPayment) => p.CreatedDate ?? null },
} satisfies Record<string, FieldMeta<SfPayment>>;

type PaymentField = keyof typeof PAYMENT_FILTERABLE;

// ── Columns ─────────────────────────────────────────────────────────────────
//
// "opportunity" is a composite cell showing opp name + account name on
// two lines (account is no longer a standalone column — same UX as
// Pipeline).

type ColKey =
  | "paymentNumber"
  | "opportunity"
  | "oppOwner"
  | "stage"
  | "recordType"
  | "active"
  | "oppAmount"
  | "mgrProb"
  | "riskAdjusted"
  | "closeDate"
  | "amount"
  | "scheduledDate"
  | "paymentDate"
  | "paid"
  | "method"
  | "status"
  | "department"
  | "glAccount"
  | "amountReceived"
  | "reconciled"
  | "writtenOff"
  | "createdDate";

const COLUMN_ORDER: ColKey[] = [
  "paymentNumber",
  "opportunity",
  "oppOwner",
  "stage",
  "recordType",
  "active",
  "oppAmount",
  "mgrProb",
  "riskAdjusted",
  "closeDate",
  "amount",
  "scheduledDate",
  "paymentDate",
  "paid",
  "method",
  "status",
  "department",
  "glAccount",
  "amountReceived",
  "reconciled",
  "writtenOff",
  "createdDate",
];

// Default visible set covers the top-priority columns Jac asked for:
// Opp Owner, Stage, Amount (opp), Manager Probability, Risk-Adjusted
// Value, Scheduled Date, Payment Amount, Close Date — plus the always-
// useful Opportunity (with account beneath) and Paid status.
const DEFAULT_VISIBLE_COLS: ColKey[] = [
  "opportunity",
  "oppOwner",
  "stage",
  "oppAmount",
  "mgrProb",
  "riskAdjusted",
  "scheduledDate",
  "amount",
  "closeDate",
  "paid",
];

const COL_LABELS: Record<ColKey, string> = {
  paymentNumber: "Payment #",
  opportunity: "Opportunity",
  oppOwner: "Opp owner",
  stage: "Stage",
  recordType: "Record type",
  active: "Active",
  oppAmount: "Opp amount",
  mgrProb: "Mgr prob.",
  riskAdjusted: "Risk-adj",
  closeDate: "Close",
  amount: "Pmt amount",
  scheduledDate: "Scheduled",
  paymentDate: "Paid date",
  paid: "Paid",
  method: "Method",
  status: "Status",
  department: "Department",
  glAccount: "GL account",
  amountReceived: "Received",
  reconciled: "Reconciled",
  writtenOff: "Written off",
  createdDate: "Created",
};

// Tightened defaults so the priority column set fits on a ~1100 px
// content area (sidebar collapsed: ~1380, expanded: ~1100 on a 1440
// viewport). Users can still resize either direction; the per-page
// localStorage map captures any deviations.
// Tight defaults. The shortest columns (paid / active / written off /
// reconciled / mgr prob) sit just above the resize floor so users can
// nudge them down further when packing many columns in view. Long-text
// columns (opp, dept, GL) stay wider because truncation hurts at sub-
// 100 px.
// Data-type-driven defaults. The constants below match the visual width
// of the longest realistic value at our content font size, plus 16 px of
// horizontal padding:
//   • Currency (mono "$1,234,567"):  ~76 px
//   • Short date ("Apr 8, 2026"):    ~68 px
//   • Percent ("100%"):              ~44 px
//   • Single short word chip:        ~80 px
//   • Owner / multi-word name:       ~90 px (truncated)
//   • Composite opp+account cell:    ~190 px (longest column, two lines)
//   • Boolean colored-dot cells:      ~28 px (icon-only)
// Users can still drag any column wider — these are floors.
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  paymentNumber: 72,
  opportunity: 190,
  oppOwner: 90,
  stage: 80,
  recordType: 90,
  active: 28,
  oppAmount: 76,
  mgrProb: 44,
  riskAdjusted: 76,
  closeDate: 68,
  amount: 76,
  scheduledDate: 68,
  paymentDate: 68,
  paid: 28,
  method: 80,
  status: 90,
  department: 110,
  glAccount: 120,
  amountReceived: 76,
  reconciled: 28,
  writtenOff: 28,
  createdDate: 68,
};

const ROW_HEIGHT = 44;

const PAYMENTS_REFERRER = {
  from: { pathname: "/payments", label: "Payments" },
} as const;

interface PaymentsSavedView {
  scope?: Scope;
  rules?: FilterRule<PaymentField>[];
  /** Visible column keys, in display order (drag-reorder persists here). */
  visibleCols?: ColKey[];
  widths?: Partial<Record<ColKey, number>>;
}

function extractPayment(p: SfPayment, key: ColKey): unknown {
  switch (key) {
    case "paymentNumber": return p.Name ?? "";
    case "opportunity": return p.npe01__Opportunity__r?.Name ?? "";
    case "oppOwner": return p.npe01__Opportunity__r?.Owner?.Name ?? "";
    case "stage": return p.npe01__Opportunity__r?.StageName ?? "";
    case "recordType": return p.npe01__Opportunity__r?.RecordType?.Name ?? "";
    case "active": return p.npe01__Opportunity__r?.Active_Opportunity__c ? 1 : 0;
    case "oppAmount": return p.npe01__Opportunity__r?.Amount ?? 0;
    case "mgrProb": return p.npe01__Opportunity__r?.Manager_Probability_Override__c ?? p.npe01__Opportunity__r?.Probability ?? 0;
    case "riskAdjusted": return riskAdjusted(p) ?? 0;
    case "closeDate": return p.npe01__Opportunity__r?.CloseDate ?? "";
    case "amount": return p.npe01__Payment_Amount__c ?? 0;
    case "scheduledDate": return p.npe01__Scheduled_Date__c ?? "";
    case "paymentDate": return p.npe01__Payment_Date__c ?? "";
    case "paid": return p.npe01__Paid__c ? 1 : 0;
    case "method": return p.npe01__Payment_Method__c ?? "";
    case "status": return p.Paid_Status__c ?? p.Payment_Status__c ?? "";
    case "department": return p.Department__c ?? "";
    case "glAccount": return p.GL_Account__c ?? "";
    case "amountReceived": return p.Amount_Received__c ?? 0;
    case "reconciled": return p.Reconciled_with_Finance__c ? 1 : 0;
    case "writtenOff": return p.npe01__Written_Off__c ? 1 : 0;
    case "createdDate": return p.CreatedDate ?? "";
  }
}

const NUMERIC_COLS: Set<ColKey> = new Set([
  "oppAmount", "mgrProb", "riskAdjusted", "amount", "amountReceived",
  "scheduledDate", "paymentDate", "closeDate", "createdDate",
]);

const PAYMENT_CSV_COLUMNS: CsvColumn<SfPayment>[] = [
  { label: "SF Id", getValue: (p) => p.Id },
  { label: "Payment #", getValue: (p) => p.Name },
  { label: "Opportunity Id", getValue: (p) => p.npe01__Opportunity__c },
  { label: "Opportunity", getValue: (p) => p.npe01__Opportunity__r?.Name },
  { label: "Account", getValue: (p) => p.npe01__Opportunity__r?.Account?.Name },
  { label: "Opp Owner", getValue: (p) => p.npe01__Opportunity__r?.Owner?.Name },
  { label: "Stage", getValue: (p) => p.npe01__Opportunity__r?.StageName },
  { label: "Record Type", getValue: (p) => p.npe01__Opportunity__r?.RecordType?.Name },
  { label: "Active Opp", getValue: (p) => (p.npe01__Opportunity__r?.Active_Opportunity__c ? "Yes" : "No") },
  { label: "Opp Amount", getValue: (p) => p.npe01__Opportunity__r?.Amount ?? "" },
  { label: "Mgr Probability Override", getValue: (p) => p.npe01__Opportunity__r?.Manager_Probability_Override__c ?? "" },
  { label: "Probability", getValue: (p) => p.npe01__Opportunity__r?.Probability ?? "" },
  { label: "Risk-Adjusted Value", getValue: (p) => riskAdjusted(p) ?? "" },
  { label: "Close Date", getValue: (p) => isoDate(p.npe01__Opportunity__r?.CloseDate) },
  { label: "Payment Amount", getValue: (p) => p.npe01__Payment_Amount__c ?? "" },
  { label: "Scheduled Date", getValue: (p) => isoDate(p.npe01__Scheduled_Date__c) },
  { label: "Payment Date", getValue: (p) => isoDate(p.npe01__Payment_Date__c) },
  { label: "Paid", getValue: (p) => (p.npe01__Paid__c ? "Yes" : "No") },
  { label: "Method", getValue: (p) => p.npe01__Payment_Method__c },
  { label: "Status", getValue: (p) => p.Paid_Status__c ?? p.Payment_Status__c },
  { label: "Delinquent", getValue: (p) => (p.Delinquent__c ? "Yes" : "No") },
  { label: "Written Off", getValue: (p) => (p.npe01__Written_Off__c ? "Yes" : "No") },
  { label: "Write-off reason", getValue: (p) => p.Write_off_reason__c },
  { label: "Department", getValue: (p) => p.Department__c },
  { label: "GL Account", getValue: (p) => p.GL_Account__c },
  { label: "Reconciled", getValue: (p) => (p.Reconciled_with_Finance__c ? "Yes" : "No") },
  { label: "Amount Received", getValue: (p) => p.Amount_Received__c ?? "" },
  { label: "Amount Minus Received", getValue: (p) => p.Amount_Minus_Received__c ?? "" },
  { label: "Batch", getValue: (p) => p.Batch_Name__c },
  { label: "Check #", getValue: (p) => p.npe01__Check_Reference_Number__c },
  { label: "Created", getValue: (p) => isoDate(p.CreatedDate) },
];

function isoDate(v?: string | null): string {
  if (!v) return "";
  return v.slice(0, 10);
}

// ── Page ────────────────────────────────────────────────────────────────────

export function PaymentsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = usePayments();
  // Advisory hygiene flags — the primary surface for them. Deliberately not
  // awaited alongside the rows: payments render immediately and the tint
  // arrives when it arrives. A failed flags call must never hold up the grid.
  const { data: reviewFlags } = usePipelineReviewFlags();
  const reviewRuleLabels = useMemo(() => ruleLabels(reviewFlags), [reviewFlags]);
  const updatePayment = useUpdateAnyPayment();
  // Stage + Manager Probability live on the parent Opportunity, not the
  // Payment row, so they go through opportunity-side mutations.
  // useUpdateOpportunityStage handles the SF validate + award
  // auto-create handshake; useUpdateOpportunity is generic.
  const updateOpp = useUpdateOpportunity();
  const stageGate = useStageChangeGate();
  const probGate = useProbabilityScheduleGate();
  const canEdit = usePerm("edit_all_opportunities");

  const payments = data ?? [];

  const [scope, setScope] = useState<Scope>("all");
  const [rules, setRules] = useState<FilterRule<PaymentField>[]>([]);
  const [q, setQ] = useState("");

  const { sort, toggle } = useSort<ColKey>({
    key: "scheduledDate",
    direction: "asc",
  });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:payments:v2", COLUMN_ORDER, DEFAULT_VISIBLE_COLS);
  const { widths, startResize, replaceAll: replaceWidths } = useColumnWidths<ColKey>(
    // Bumped to v4 so each iteration of the tighter defaults takes
    // effect on next reload (saved widths shadow defaults).
    "bedrock-v2:cols:payments:v5",
    DEFAULT_WIDTHS,
    { min: 16 },
  );

  // Inline expansion — clicking the chevron next to an opportunity
  // name pops a per-opp tasks + activity panel below the row, same
  // pattern as Pipeline. Sticky per-session via useSessionState so
  // tab-back-from-detail restores the prior expansion.
  const [expandedOppId, setExpandedOppId] = useSessionState<string | null>("payments:expandedOppId", null);

  // Discovered values for select-filter dropdowns.
  const chipFacets = useMemo(() => {
    const methods = new Set<string>();
    const statuses = new Set<string>();
    const depts = new Set<string>();
    const gls = new Set<string>();
    const stages = new Set<string>();
    const recordTypes = new Set<string>();
    const philanthropyTypes = new Set<string>();
    const owners = new Map<string, string>();
    for (const p of payments) {
      const o = p.npe01__Opportunity__r;
      if (p.npe01__Payment_Method__c) methods.add(p.npe01__Payment_Method__c);
      const st = p.Paid_Status__c ?? p.Payment_Status__c;
      if (st) statuses.add(st);
      if (p.Department__c) depts.add(p.Department__c);
      if (p.GL_Account__c) gls.add(p.GL_Account__c);
      if (o?.StageName) stages.add(o.StageName);
      if (o?.RecordType?.Name) recordTypes.add(o.RecordType.Name);
      if (o?.Philanthropy_Type__c) philanthropyTypes.add(o.Philanthropy_Type__c);
      if (o?.OwnerId && o.Owner?.Name && !owners.has(o.OwnerId)) {
        owners.set(o.OwnerId, o.Owner.Name);
      }
    }
    const yesNo = [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }];
    const toOpt = (s: Set<string>) =>
      Array.from(s).sort().map((v) => ({ value: v, label: v }));
    return {
      paid: yesNo,
      writtenOff: yesNo,
      delinquent: yesNo,
      reconciled: yesNo,
      active: yesNo,
      method: toOpt(methods),
      status: toOpt(statuses),
      department: toOpt(depts),
      glAccount: toOpt(gls),
      stage: toOpt(stages),
      recordType: toOpt(recordTypes),
      philanthropyType: toOpt(philanthropyTypes),
      oppOwner: Array.from(owners.entries())
        .map(([id, name]) => ({ value: id, label: name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }, [payments]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filt = payments.filter((p) => {
      if (!inScope(p, scope)) return false;
      if (needle) {
        const o = p.npe01__Opportunity__r;
        const hay =
          (p.Name ?? "") + " " +
          (o?.Name ?? "") + " " +
          (o?.Account?.Name ?? "") + " " +
          (p.Batch_Name__c ?? "") + " " +
          (p.npe01__Check_Reference_Number__c ?? "");
        if (!hay.toLowerCase().includes(needle)) return false;
      }
      for (const r of rules) {
        if (!ruleApplies(p, r, PAYMENT_FILTERABLE)) return false;
      }
      return true;
    });
    return sortBy(filt, sort, extractPayment);
  }, [payments, scope, q, rules, sort]);

  const totals = useMemo(() => {
    let amount = 0, received = 0, riskAdj = 0;
    for (const p of filtered) {
      amount += p.npe01__Payment_Amount__c ?? 0;
      received += p.Amount_Received__c ?? 0;
      const ra = riskAdjusted(p);
      if (ra != null) riskAdj += ra;
    }
    return { amount, received, riskAdj };
  }, [filtered]);

  const savePatch = useCallback(
    async (id: string, patch: PaymentPatch) => {
      await updatePayment.mutateAsync({ id, patch });
    },
    [updatePayment],
  );

  const saveOppStage = useCallback(
    async (p: SfPayment, nextStage: string) => {
      const oppId = p.npe01__Opportunity__c;
      if (!oppId) return;
      const joined = p.npe01__Opportunity__r ?? {};
      // Construct a minimal SfOpportunity from the join so the gate
      // can introspect the current stage / amount / probability and
      // seed the dialog. Fields the gate looks at are all present on
      // the join (StageName, CloseDate, Amount, Probability, override).
      const opp: SfOpportunity = {
        Id: oppId,
        Name: joined.Name ?? "",
        StageName: joined.StageName ?? "",
        IsClosed: null,
        Probability: joined.Probability ?? null,
        Amount: joined.Amount ?? null,
        Manager_Probability_Override__c: joined.Manager_Probability_Override__c ?? null,
        CloseDate: joined.CloseDate ?? null,
        Active_Opportunity__c: joined.Active_Opportunity__c ?? null,
        Account: joined.Account ? { Id: joined.AccountId ?? "", Name: joined.Account.Name ?? "" } : null,
        AccountId: joined.AccountId ?? null,
      } as SfOpportunity;
      await stageGate.request(opp, nextStage);
    },
    [stageGate],
  );

  const saveOppMgrProb = useCallback(
    async (p: SfPayment, raw: string) => {
      const oppId = p.npe01__Opportunity__c;
      if (!oppId) return;
      const joined = p.npe01__Opportunity__r ?? {};
      const trimmed = raw.trim();
      const next = trimmed === "" ? null : Number(trimmed.replace(/[^0-9.-]/g, ""));

      // Build a minimal SfOpportunity for the playbook gate. The gate
      // looks at Probability + override + Amount + Id; all are on the
      // payment row's join.
      const opp: SfOpportunity = {
        Id: oppId,
        Name: joined.Name ?? "",
        StageName: joined.StageName ?? "",
        Probability: joined.Probability ?? null,
        Amount: joined.Amount ?? null,
        Manager_Probability_Override__c: joined.Manager_Probability_Override__c ?? null,
        CloseDate: joined.CloseDate ?? null,
      } as SfOpportunity;
      // Block 0 → >0 if no schedule exists; opens PaymentScheduleBuilder
      // and resolves only after save. Rejection here reverts the
      // InlineText's optimistic display via its own catch handler.
      await probGate.request(opp, next);

      const patch: Record<string, unknown> = { Manager_Probability_Override__c: next };
      if (next != null) patch.Probability = next;
      await updateOpp.mutateAsync({ id: oppId, patch });
    },
    [updateOpp, probGate],
  );

  // ── Virtualization ─────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const row = filtered[i];
      return row?.npe01__Opportunity__c === expandedOppId
        ? ROW_HEIGHT + OPP_PANEL_HEIGHT
        : ROW_HEIGHT;
    },
    overscan: 10,
  });
  // Recompute item sizes when the expanded row changes.
  useEffect(() => {
    virtualizer.measure();
  }, [expandedOppId, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  const tableMinWidth = totalWidth(widths);

  return (
    <div className="flex h-full flex-col px-7 py-6">
      <PageHeader
        title="Payments"
        subtitle={
          isLoading
            ? "Loading…"
            : `${filtered.length.toLocaleString()} of ${payments.length.toLocaleString()} · ${fmtMoney(totals.amount)} scheduled · ${fmtMoney(totals.riskAdj)} risk-adj · ${fmtMoney(totals.received)} received`
        }
      />

      {/* Toolbar — flex-wrap + gap-y so the rightmost controls drop
          to a second row on narrow viewports instead of clipping off
          the right edge (the original single-line toolbar was cutting
          off the Saved Views picker at sub-1280px widths). */}
      <Toolbar className="mt-4 flex-wrap gap-y-2">
        <ButtonGroup
          value={scope}
          onChange={(v) => setScope(v as Scope)}
          options={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
        />
        <div className="relative">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search opp, account, payment # …"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-72 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
        <AddFilterButton<PaymentField>
          filterable={PAYMENT_FILTERABLE as Record<PaymentField, FieldMeta<unknown>>}
          selectOptions={{
            paid: chipFacets.paid,
            writtenOff: chipFacets.writtenOff,
            delinquent: chipFacets.delinquent,
            reconciled: chipFacets.reconciled,
            active: chipFacets.active,
            method: chipFacets.method,
            status: chipFacets.status,
            department: chipFacets.department,
            glAccount: chipFacets.glAccount,
            stage: chipFacets.stage,
            recordType: chipFacets.recordType,
            philanthropyType: chipFacets.philanthropyType,
            oppOwner: chipFacets.oppOwner,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <div className="ml-auto flex items-center gap-2">
          <ExportCsvButton<SfPayment>
            rows={filtered}
            columns={PAYMENT_CSV_COLUMNS}
            baseFilename="payments"
          />
          <ColumnChooser
            allColumns={COLUMN_ORDER}
            labels={COL_LABELS}
            visible={visibleCols}
            required={["opportunity"]}
            onToggle={toggleCol}
          />
          <SavedViewsPicker<PaymentsSavedView>
            scopeKey="payments"
            currentFilters={{ scope, rules, visibleCols, widths }}
            onLoad={(v) => {
              setScope(v.scope ?? "all");
              setRules(v.rules ?? []);
              if (v.visibleCols && v.visibleCols.length > 0) replaceVisibleCols(v.visibleCols);
              if (v.widths && Object.keys(v.widths).length > 0) replaceWidths(v.widths);
            }}
          />
        </div>
      </Toolbar>

      {/* Active chip row */}
      {rules.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, PAYMENT_FILTERABLE)}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules([])}
            className="ml-1 text-[11px] font-medium text-ink-3 hover:text-accent"
          >
            Clear
          </button>
        </div>
      ) : null}

      {/* Table */}
      <div
        ref={scrollRef}
        className="relative mt-0 flex-1 overflow-auto border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{
            tableLayout: "fixed",
            width: "100%",
            minWidth: tableMinWidth,
          }}
        >
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-10 border-b border-border-strong bg-surface-2 text-[11px] uppercase tracking-wider text-ink-3">
            <tr>
              {visibleCols.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align={NUMERIC_COLS.has(key) ? "right" : "left"}
                  isLast={idx === visibleCols.length - 1}
                >
                  <SortableHeader
                    label={COL_LABELS[key]}
                    sortKey={key}
                    sort={sort}
                    onToggle={toggle}
                  />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-10 text-center text-[13px] text-ink-3">
                  Loading payments…
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-10 text-center text-[13px] text-red">
                  Failed to load payments
                  {error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-10 text-center text-[13px] text-ink-3">
                  {payments.length === 0
                    ? "No payments. (Is Salesforce connected?)"
                    : "No payments match your filters."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
                {virtualItems.map((vi) => {
                  const p = filtered[vi.index];
                  const oppId = p.npe01__Opportunity__c ?? null;
                  const isExpanded = oppId != null && oppId === expandedOppId;
                  return (
                    <Fragment key={p.Id}>
                      <PaymentRow
                        p={p}
                        visibleCols={visibleCols}
                        canEdit={canEdit}
                        isExpanded={isExpanded}
                        onToggleExpand={() => {
                          if (!oppId) return;
                          setExpandedOppId(isExpanded ? null : oppId);
                        }}
                        onSave={savePatch}
                        onSaveOppStage={saveOppStage}
                        onSaveOppMgrProb={saveOppMgrProb}
                        onOpenOpp={(id) =>
                          navigate(`/opportunities/${id}`, { state: PAYMENTS_REFERRER })
                        }
                        flags={reviewFlags?.payments[p.Id]}
                        ruleLabel={reviewRuleLabels}
                      />
                      {isExpanded && oppId ? (
                        <tr>
                          <td colSpan={visibleCols.length} className="p-0">
                            <OpportunityExpandPanel
                              opportunityId={oppId}
                              oppAmount={p.npe01__Opportunity__r?.Amount ?? null}
                              oppCloseDate={p.npe01__Opportunity__r?.CloseDate ?? null}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
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
          existingPayments={[]}
          initialFirstDate={probGate.pending.opp.CloseDate ?? null}
          prompt={`Raising probability to ${probGate.pending.nextProbability}% — set the expected payment schedule before continuing.`}
          onClose={probGate.dismiss}
          onSaved={probGate.complete}
        />
      ) : null}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

interface RowProps {
  p: SfPayment;
  visibleCols: ColKey[];
  canEdit: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSave: (id: string, patch: PaymentPatch) => Promise<void>;
  onSaveOppStage: (p: SfPayment, nextStage: string) => Promise<void>;
  onSaveOppMgrProb: (p: SfPayment, raw: string) => Promise<void>;
  onOpenOpp: (oppId: string) => void;
  /** Advisory hygiene flags for this payment, absent when it's clean. */
  flags?: PaymentFlags;
  /** Rule key → sentence, for the hover text. */
  ruleLabel: Record<string, string>;
}

const METHOD_OPTIONS = [
  { value: "", label: "—" },
  ...PAYMENT_METHODS.map((m) => ({ value: m, label: m })),
];

const DEPARTMENT_OPTIONS = [
  { value: "", label: "—" },
  ...DEPARTMENTS.map((d) => ({ value: d, label: d })),
];

const GL_OPTIONS = [
  { value: "", label: "—" },
  ...GL_ACCOUNTS.map((g) => ({ value: g, label: g })),
];

const YESNO_OPTIONS = [
  { value: "false", label: "No" },
  { value: "true", label: "Yes" },
];

function moneyDisplay(raw: string): string {
  const n = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? fmtMoneyFull(n) : raw;
}

// Stage dropdown — uses the same curated 7-stage funnel + Closed Lost
// + Withdrawn that Pipeline.tsx surfaces (see lib/stages.ts). If the
// current opp is in a legacy stage that isn't in the curated list, we
// prepend it as a (legacy) entry so the resting value renders without
// the dropdown forcing a change. */
function stageOptionsFor(currentStage: string | null | undefined) {
  const out = SF_STAGE_OPTIONS.map((s) => ({ value: s.value, label: s.label }));
  if (currentStage && !SF_STAGE_OPTIONS.some((s) => s.value === currentStage)) {
    out.unshift({ value: currentStage, label: `${currentStage} (legacy)` });
  }
  return out;
}

const PaymentRow = memo(function PaymentRow({
  p, visibleCols, canEdit, isExpanded, onToggleExpand,
  onSave, onSaveOppStage, onSaveOppMgrProb, onOpenOpp,
  flags, ruleLabel,
}: RowProps) {
  const opp = p.npe01__Opportunity__r;
  const oppId = p.npe01__Opportunity__c ?? null;
  const accountName = opp?.Account?.Name ?? "—";
  const probDisplay =
    opp?.Manager_Probability_Override__c ?? opp?.Probability ?? null;
  const ra = riskAdjusted(p);
  const stageOpts = useMemo(() => stageOptionsFor(opp?.StageName), [opp?.StageName]);

  const cells: Partial<Record<ColKey, React.ReactNode>> = {
    paymentNumber: <span className="truncate font-mono text-[11.5px] text-ink-3">{p.Name ?? "—"}</span>,
    opportunity: (
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="flex-shrink-0 text-ink-4 hover:text-ink-2 transition-colors"
          aria-label={isExpanded ? "Collapse tasks" : "Expand tasks"}
          disabled={!p.npe01__Opportunity__c}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <AccountAvatar name={accountName} logoUrl={null} size={18} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <button
            type="button"
            onClick={() => p.npe01__Opportunity__c && onOpenOpp(p.npe01__Opportunity__c)}
            className="truncate text-left font-medium text-ink hover:underline"
            title={opp?.Name ?? ""}
          >
            {opp?.Name ?? p.npe01__Opportunity__c ?? "—"}
          </button>
          <span className="truncate text-[11px] text-ink-3" title={accountName}>{accountName}</span>
        </div>
      </div>
    ),
    oppOwner: <span className="truncate text-ink-2">{opp?.Owner?.Name ?? "—"}</span>,
    stage: canEdit && oppId ? (
      <InlineSelect
        value={opp?.StageName ?? ""}
        options={stageOpts}
        onSave={(v) => onSaveOppStage(p, v)}
        renderValue={(v) =>
          v
            ? <StageChip stage={v} status={stageStatus({ StageName: v, IsClosed: false })} />
            : <span className="text-ink-4">—</span>
        }
      />
    ) : opp?.StageName ? (
      <StageChip stage={opp.StageName} status={stageStatus({ StageName: opp.StageName, IsClosed: false })} />
    ) : (
      <span className="text-ink-4">—</span>
    ),
    recordType: <span className="truncate text-ink-2">{opp?.RecordType?.Name ?? "—"}</span>,
    active: opp?.Active_Opportunity__c ? (
      <span
        className="block h-2 w-2 rounded-full bg-green"
        title="Active opportunity"
        aria-label="Active"
      />
    ) : (
      <span className="text-ink-4" aria-label="Not active">—</span>
    ),
    oppAmount: (
      <span className="block text-right tabular-nums text-ink-2">
        {opp?.Amount != null ? fmtMoney(opp.Amount) : "—"}
      </span>
    ),
    mgrProb: canEdit && oppId ? (
      <InlineText
        value={
          opp?.Manager_Probability_Override__c != null
            ? String(opp.Manager_Probability_Override__c)
            : opp?.Probability != null
              ? String(opp.Probability)
              : ""
        }
        onSave={(v) => onSaveOppMgrProb(p, v)}
        formatDisplay={(raw) => {
          const n = Number(raw);
          return Number.isFinite(n) ? `${n}%` : raw;
        }}
        placeholder="—"
        className="justify-end text-right"
      />
    ) : (
      <span className="block text-right tabular-nums text-ink-2">
        {probDisplay != null ? `${probDisplay}%` : "—"}
      </span>
    ),
    riskAdjusted: (
      <span className="block text-right tabular-nums text-ink-2">
        {ra != null ? fmtMoney(ra) : "—"}
      </span>
    ),
    closeDate: (
      <span className="block text-right tabular-nums text-ink-2">{fmtDate(opp?.CloseDate)}</span>
    ),
    amount: canEdit ? (
      <InlineText
        value={p.npe01__Payment_Amount__c != null ? String(p.npe01__Payment_Amount__c) : ""}
        onSave={(v) => onSave(p.Id, { npe01__Payment_Amount__c: v ? Number(v.replace(/[^0-9.-]/g, "")) : 0 })}
        formatDisplay={moneyDisplay}
        placeholder="—"
        className="justify-end text-right"
      />
    ) : (
      <span className="block text-right tabular-nums">
        {p.npe01__Payment_Amount__c != null ? fmtMoney(p.npe01__Payment_Amount__c) : "—"}
      </span>
    ),
    scheduledDate: canEdit ? (
      <InlineDate
        value={p.npe01__Scheduled_Date__c}
        onSave={(v) => onSave(p.Id, { npe01__Scheduled_Date__c: v })}
        placeholder="—"
        align="right"
      />
    ) : (
      <span className="block text-right tabular-nums text-ink-2">{fmtDate(p.npe01__Scheduled_Date__c)}</span>
    ),
    paymentDate: canEdit ? (
      <InlineDate
        value={p.npe01__Payment_Date__c}
        onSave={(v) => onSave(p.Id, { npe01__Payment_Date__c: v })}
        placeholder="—"
        align="right"
      />
    ) : (
      <span className="block text-right tabular-nums text-ink-2">{fmtDate(p.npe01__Payment_Date__c)}</span>
    ),
    paid: canEdit ? (
      <InlineSelect
        value={p.npe01__Paid__c ? "true" : "false"}
        options={YESNO_OPTIONS}
        onSave={(v) => onSave(p.Id, { npe01__Paid__c: v === "true" })}
        renderValue={(v) =>
          v === "true" ? (
            <span className="block h-2 w-2 rounded-full bg-green" title="Paid" aria-label="Paid" />
          ) : (
            <span className="text-ink-4" aria-label="Unpaid">—</span>
          )
        }
      />
    ) : p.npe01__Paid__c ? (
      <span className="block h-2 w-2 rounded-full bg-green" title="Paid" aria-label="Paid" />
    ) : (
      <span className="text-ink-4" aria-label="Unpaid">—</span>
    ),
    method: canEdit ? (
      <InlineSelect
        value={p.npe01__Payment_Method__c ?? ""}
        options={METHOD_OPTIONS}
        onSave={(v) => onSave(p.Id, { npe01__Payment_Method__c: v || null })}
        renderValue={(v) => <span className="truncate text-ink-2">{v || "—"}</span>}
      />
    ) : (
      <span className="truncate text-ink-2">{p.npe01__Payment_Method__c ?? "—"}</span>
    ),
    status: (
      <span className="truncate text-ink-2">
        {p.Paid_Status__c ?? p.Payment_Status__c ?? "—"}
      </span>
    ),
    department: canEdit ? (
      <InlineSelect
        value={p.Department__c ?? ""}
        options={DEPARTMENT_OPTIONS}
        onSave={(v) => onSave(p.Id, { Department__c: v || null })}
        renderValue={(v) => <span className="truncate text-ink-2">{v || "—"}</span>}
      />
    ) : (
      <span className="truncate text-ink-2">{p.Department__c ?? "—"}</span>
    ),
    glAccount: canEdit ? (
      <InlineSelect
        value={p.GL_Account__c ?? ""}
        options={GL_OPTIONS}
        onSave={(v) => onSave(p.Id, { GL_Account__c: v || null })}
        renderValue={(v) => <span className="truncate text-ink-2">{v || "—"}</span>}
      />
    ) : (
      <span className="truncate text-ink-2">{p.GL_Account__c ?? "—"}</span>
    ),
    amountReceived: (
      <span className="block text-right tabular-nums text-ink-2">
        {p.Amount_Received__c != null ? fmtMoney(p.Amount_Received__c) : "—"}
      </span>
    ),
    reconciled: canEdit ? (
      <InlineSelect
        value={p.Reconciled_with_Finance__c ? "true" : "false"}
        options={YESNO_OPTIONS}
        onSave={(v) => onSave(p.Id, { Reconciled_with_Finance__c: v === "true" })}
        renderValue={(v) =>
          v === "true" ? (
            <span className="block h-2 w-2 rounded-full bg-green" title="Reconciled" aria-label="Reconciled" />
          ) : (
            <span className="text-ink-4" aria-label="Not reconciled">—</span>
          )
        }
      />
    ) : p.Reconciled_with_Finance__c ? (
      <span className="block h-2 w-2 rounded-full bg-green" title="Reconciled" aria-label="Reconciled" />
    ) : (
      <span className="text-ink-4" aria-label="Not reconciled">—</span>
    ),
    writtenOff: canEdit ? (
      <InlineSelect
        value={p.npe01__Written_Off__c ? "true" : "false"}
        options={YESNO_OPTIONS}
        onSave={(v) => onSave(p.Id, { npe01__Written_Off__c: v === "true" })}
        renderValue={(v) =>
          v === "true" ? (
            <span className="block h-2 w-2 rounded-full bg-amber" title="Written off" aria-label="Written off" />
          ) : (
            <span className="text-ink-4" aria-label="Not written off">—</span>
          )
        }
      />
    ) : p.npe01__Written_Off__c ? (
      <span className="block h-2 w-2 rounded-full bg-amber" title="Written off" aria-label="Written off" />
    ) : (
      <span className="text-ink-4" aria-label="Not written off">—</span>
    ),
    createdDate: (
      <span className="block text-right tabular-nums text-ink-3">{fmtDate(p.CreatedDate)}</span>
    ),
  };

  // Advisory tint. `bg-amber-soft` at full strength on purpose: the palette is
  // declared as bare `var(--x)` in tailwind.config.ts, so Tailwind can't
  // compose an alpha channel and any `/opacity` modifier is silently dropped.
  // --amber-soft is already a pale wash, which is the weight we want.
  //
  // This is the page the rules were written for: every one of them names a
  // column that exists here, so a flag lands on the exact cell to change
  // rather than on a roll-up.
  const flagWhy = (key: ColKey): string | undefined => {
    const rules = flags?.cells[key];
    if (!rules?.length) return undefined;
    return rules.map((r) => `• ${ruleLabel[r] ?? r}`).join("\n");
  };

  return (
    <tr className="border-b border-border-strong hover:bg-surface-2/50" style={{ height: ROW_HEIGHT }}>
      {visibleCols.map((key) => (
        <td
          key={key}
          className={cn("overflow-hidden px-2 py-1.5", flags?.cells[key] && "bg-amber-soft")}
          title={flagWhy(key)}
        >
          {cells[key]}
        </td>
      ))}
    </tr>
  );
});
