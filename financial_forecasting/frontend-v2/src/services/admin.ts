import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

// ── Permission profiles ─────────────────────────────────────────────────

export interface PermissionProfile {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
  permissions: Record<string, boolean>;
  created_at?: string | null;
  updated_at?: string | null;
}

interface EnvelopedList<T> {
  success: boolean;
  data: T[];
}

interface EnvelopedSingle<T> {
  success: boolean;
  data: T;
}

export function usePermissionProfiles() {
  return useQuery({
    queryKey: ["permission-profiles"],
    queryFn: async () => {
      const { data } = await api.get<EnvelopedList<PermissionProfile>>(
        "/api/permissions/profiles",
      );
      return data?.data ?? [];
    },
    staleTime: 60_000,
  });
}

export function useCreatePermissionProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      name: string;
      description?: string;
      is_default?: boolean;
      permissions?: Record<string, boolean>;
    }) => {
      const { data } = await api.post<EnvelopedSingle<PermissionProfile>>(
        "/api/permissions/profiles",
        body,
      );
      return data.data;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["permission-profiles"] }),
  });
}

export function useUpdatePermissionProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      patch: Partial<{
        name: string;
        description: string;
        is_default: boolean;
        permissions: Record<string, boolean>;
      }>;
    }) => {
      const { data } = await api.put<EnvelopedSingle<PermissionProfile>>(
        `/api/permissions/profiles/${encodeURIComponent(vars.id)}`,
        vars.patch,
      );
      return data.data;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["permission-profiles"] }),
  });
}

export function useDeletePermissionProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(
        `/api/permissions/profiles/${encodeURIComponent(id)}`,
      );
      return id;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["permission-profiles"] }),
  });
}

// ── App users (Bedrock-side identity + profile assignment) ─────────────

export interface AppUser {
  id: string;
  sf_user_id: string | null;
  email: string;
  name: string | null;
  is_active: boolean;
  profile_id: string | null;
  profile_name: string | null;
}

export function useAppUsers() {
  return useQuery({
    queryKey: ["app-users"],
    queryFn: async () => {
      const { data } = await api.get<EnvelopedList<AppUser>>(
        "/api/permissions/users",
      );
      return data?.data ?? [];
    },
    staleTime: 30_000,
  });
}

export function useUpdateAppUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      patch: Partial<{
        profile_id: string;
        sf_user_id: string | null;
        name: string;
        is_active: boolean;
      }>;
    }) => {
      const { data } = await api.put<EnvelopedSingle<AppUser>>(
        `/api/permissions/users/${encodeURIComponent(vars.id)}`,
        vars.patch,
      );
      return data.data;
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["app-users"] });
      const prev = qc.getQueryData<AppUser[]>(["app-users"]);
      if (prev) {
        qc.setQueryData<AppUser[]>(
          ["app-users"],
          prev.map((u) => (u.id === id ? { ...u, ...patch } : u)),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["app-users"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["app-users"] }),
  });
}

// ── Permission catalog ─────────────────────────────────────────────────
//
// Mirrors the backend PERMISSION_KEYS list (routes/permissions.py:19) and
// groups them for the matrix UI. System keys are flagged so non-admins
// see them locked.

export const SYSTEM_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "manage_users_roles",
  "edit_permission_profiles",
  "trigger_data_sync",
  "pebble_crm_write",
]);

export interface PermissionGroup {
  label: string;
  keys: { key: string; label: string }[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    label: "Opportunities",
    keys: [
      { key: "view_opportunities", label: "View opportunities" },
      { key: "edit_own_opportunities", label: "Edit own opportunities" },
      { key: "edit_all_opportunities", label: "Edit all opportunities" },
      { key: "create_opportunities", label: "Create opportunities" },
      { key: "bulk_update_opportunities", label: "Bulk update" },
      { key: "lock_own_opportunities", label: "Lock own opportunities" },
      { key: "reassign_opportunities", label: "Reassign opportunities" },
    ],
  },
  {
    label: "Tasks",
    keys: [
      { key: "view_tasks", label: "View tasks" },
      { key: "edit_own_tasks", label: "Edit own tasks" },
      { key: "edit_all_tasks", label: "Edit all tasks" },
      { key: "create_tasks", label: "Create tasks" },
    ],
  },
  {
    label: "Accounts & Contacts",
    keys: [
      { key: "edit_accounts", label: "Edit accounts" },
      { key: "edit_all_accounts", label: "Edit all accounts" },
      { key: "reassign_accounts", label: "Reassign accounts" },
      { key: "create_accounts", label: "Create accounts" },
      { key: "edit_contacts", label: "Edit contacts" },
      { key: "create_contacts", label: "Create contacts" },
    ],
  },
  {
    label: "Finance",
    keys: [
      { key: "edit_payments", label: "Edit payments" },
      { key: "create_payments", label: "Create payments" },
      { key: "view_revenue_dashboard", label: "View revenue dashboard" },
      { key: "view_cashflow_forecasts", label: "View cashflow forecasts" },
      { key: "view_sage_invoices_payments", label: "View Sage invoices/payments" },
      { key: "create_sage_invoices", label: "Create Sage invoices" },
      { key: "match_invoices", label: "Match invoices" },
      { key: "manage_payment_schedules", label: "Manage payment schedules" },
      { key: "generate_financial_reports", label: "Generate financial reports" },
    ],
  },
  {
    label: "Projects",
    keys: [
      { key: "view_projects", label: "View projects" },
      { key: "edit_projects", label: "Edit projects" },
    ],
  },
  {
    label: "Pebble",
    keys: [
      { key: "use_pebble_chat", label: "Use Pebble chat" },
      { key: "use_pebble_research", label: "Use Pebble research" },
      { key: "pebble_crm_write", label: "Allow Pebble CRM writes (system)" },
    ],
  },
  {
    label: "System",
    keys: [
      { key: "trigger_data_sync", label: "Trigger data sync (system)" },
      { key: "manage_users_roles", label: "Manage users & roles (admin)" },
      { key: "edit_permission_profiles", label: "Edit permission profiles (system)" },
      { key: "manage_owner_goals", label: "Manage owner targets" },
    ],
  },
];
