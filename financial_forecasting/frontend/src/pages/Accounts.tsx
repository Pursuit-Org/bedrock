import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatDollarMillions } from '../utils/formatters';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Tabs,
  Tab,
  Alert,
  TextField,
  MenuItem,
  CircularProgress,
} from '@mui/material';
import {
  Business as BusinessIcon,
  TrendingUp as TrendingUpIcon,
  Payment as PaymentIcon,
  Chat as ChatIcon,
  Person as PersonIcon,
  Add as AddIcon,
  Refresh as RefreshIcon,
  Save as SaveIcon,
  VideoCall as VideoCallIcon,
  History as HistoryIcon,
} from '@mui/icons-material';
import {
  DataGrid,
  GridColDef,
  GridRenderCellParams,
  GridValueGetterParams,
  GridToolbar,
  GridColumnVisibilityModel,
} from '@mui/x-data-grid';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import ConfirmSaveButton from '../components/ConfirmSaveButton';

import { apiService } from '../services/api';
import { getStageHexColor } from '../types/salesforce';
import { buildSchemaColumns, SchemaField } from '../utils/schemaColumns';
import { editActionColumn } from '../components/EditRowButton';
import AccountEditDialog from '../components/AccountEditDialog';
import ActivityTimeline from '../components/ActivityTimeline';
import { usePermissions } from '../contexts/PermissionsContext';
import { useDialogStack } from '../contexts/DialogStackContext';

interface Account {
  Id?: string;  // Uppercase for Salesforce format
  id?: string;  // Lowercase for backend API format
  Name?: string;  // Uppercase for Salesforce format
  name?: string;  // Lowercase for backend API format
  Type?: string;
  type?: string;
  Industry?: string;
  industry?: string;
}

interface Opportunity {
  Id: string;
  Name: string;
  StageName: string;
  Amount: number;
  Probability: number;
  CloseDate: string;
  npe01__Payments_Made__c?: number;
  Outstanding_Payments__c?: number;
  AccountId: string;
}

interface SlackMessage {
  text: string;
  user: string;
  channel: string;
  timestamp: string;
  permalink: string;
  date: string | null;
  match_type?: 'mention' | 'channel';
}

interface FirefliesMeeting {
  id: string;
  title: string;
  date: string;
  duration: number;
  attendees: Array<{
    name?: string;
    email?: string;
  }>;
  preview: string;
  keywords: string[];
  action_items: string | string[]; // Can be either a formatted string or an array
  overview?: string;
  match_score: number;
  match_reasons: string[];
  fireflies_url?: string;
  transcript_text?: string; // Full transcript if available
}

interface Contact {
  Id: string;
  Name: string;
  FirstName?: string;
  LastName: string;
  Account?: {
    Name: string;
    attributes?: any;
  };
  npsp__Primary_Affiliation__r?: {
    Name: string;
    attributes?: any;
  };
  Title?: string;
  Email?: string;
  Phone?: string;
}

// Open pipeline stages - anything actively being pursued
const OPEN_STAGES = [
  'Lead Gen',
  'New Lead',
  'Qualifying',
  'Design / Proposal Creation',
  'Proposal Negotiation',
  'Contract Creation',
  'Negotiating Contract'
];

// Format currency values
const formatCurrency = (value: number | undefined): string => {
  if (value === undefined || value === null) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

// ── Column visibility persistence ──────────────────────────────────────────

const COLUMN_STORAGE_KEY = 'bedrock:columns:accounts';

const DEFAULT_VISIBLE_ACCOUNTS = new Set([
  'Name', 'Type', 'Industry',
  'totalOpportunities', 'openOpportunities', 'wonOpportunities',
  'openPipelineValue', 'wonValue', 'totalPaid', 'outstanding',
  '__edit__',
]);

const Accounts: React.FC = () => {
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [createAccountDialogOpen, setCreateAccountDialogOpen] = useState(false);
  const [newAccountData, setNewAccountData] = useState({
    Name: '',
    Type: '',
    Website: '',
    Phone: '',
  });
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false);
  const [selectedTranscript, setSelectedTranscript] = useState<FirefliesMeeting | null>(null);

  // Edit dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editAccountId, setEditAccountId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { can, isAdmin, sfUserId } = usePermissions();
  const canEdit = isAdmin || can('edit_accounts');
  const { pushDialog } = useDialogStack();
  const [searchParams] = useSearchParams();
  const searchFromUrl = searchParams.get('search') || '';

  // Column visibility state (persisted in localStorage)
  const [columnVisibilityModel, setColumnVisibilityModel] = useState<GridColumnVisibilityModel>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return {};
  });

  // Fetch all accounts
  const { data: accountsData, isLoading: accountsLoading } = useQuery(
    'accounts',
    async () => {
      const response = await apiService.getAccounts();
      return response.data;
    }
  );

  // Fetch all opportunities
  const { data: opportunitiesData, isLoading: oppsLoading } = useQuery(
    'opportunities-for-accounts',
    async () => {
      const response = await apiService.getOpportunities();
      return response.data;
    }
  );

  // Fetch users for schema-driven OwnerId reference autocomplete. One call
  // per page mount; react-query dedupes across sibling tabs.
  const { data: usersData } = useQuery(
    'users',
    async () => {
      const response = await apiService.getUsers({ limit: 1000 });
      return response.data ?? [];
    },
    { staleTime: 10 * 60 * 1000 },
  );

  // Fetch schema for Account object
  const { data: schemaData } = useQuery(
    'account-schema',
    async () => {
      const response = await apiService.getSchemaDescribe('Account');
      return response.data;
    },
    { staleTime: 30 * 60 * 1000 }
  );

  // Ensure accounts and opportunities are always arrays
  const accounts = Array.isArray(accountsData) ? accountsData : (accountsData?.accounts || []);
  const opportunities = Array.isArray(opportunitiesData) ? opportunitiesData : (opportunitiesData?.opportunities || []);

  // Fetch Slack activity for selected account
  const { data: slackActivity, isLoading: slackLoading } = useQuery(
    ['slack-activity', selectedAccount?.name || selectedAccount?.Name],
    async () => {
      if (!selectedAccount?.name && !selectedAccount?.Name) return null;
      try {
        const response = await apiService.getAccountSlackActivity((selectedAccount.name || selectedAccount.Name)!, 30);
        return response.data;
      } catch (error: any) {
        // If Slack is not configured, return empty data
        if (error.response?.status === 503) {
          return { messages: [], total: 0, configured: false };
        }
        throw error;
      }
    },
    {
      enabled: !!(selectedAccount?.name || selectedAccount?.Name) && dialogOpen,
      retry: false,
    }
  );

  // Fetch Fireflies meeting transcripts for selected account
  const { data: firefliesActivity, isLoading: firefliesLoading } = useQuery(
    ['fireflies-activity', selectedAccount?.name || selectedAccount?.Name],
    async () => {
      if (!selectedAccount?.name && !selectedAccount?.Name) return null;
      try {
        const response = await apiService.getAccountFirefliesMeetings((selectedAccount.name || selectedAccount.Name)!, 20);
        return response.data;
      } catch (error: any) {
        // If Fireflies is not configured, return empty data
        if (error.response?.status === 503) {
          return { meetings: [], total: 0, configured: false };
        }
        throw error;
      }
    },
    {
      enabled: !!(selectedAccount?.name || selectedAccount?.Name) && dialogOpen,
      retry: false,
    }
  );

  // Fetch contacts for selected account
  const { data: accountContacts, isLoading: contactsLoading } = useQuery(
    ['account-contacts', selectedAccount?.id || selectedAccount?.Id],
    async () => {
      if (!selectedAccount?.id && !selectedAccount?.Id) return null;
      const response = await apiService.getContacts({ account_id: selectedAccount.id || selectedAccount.Id });
      return response.data;
    },
    {
      enabled: !!(selectedAccount?.id || selectedAccount?.Id) && dialogOpen,
    }
  );

  // Create account mutation
  const createAccountMutation = useMutation(
    async (data: any) => {
      const response = await apiService.createAccount(data);
      return response.data;
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries('accounts');
        toast.success('Account created successfully!');
        setCreateAccountDialogOpen(false);
        setNewAccountData({
          Name: '',
          Type: '',
          Website: '',
          Phone: '',
        });
      },
      onError: (error: any) => {
        toast.error(error.response?.data?.detail || 'Failed to create account');
      },
    }
  );

  // Using formatDollarMillions from utils instead


  // Pre-calculate metrics for all accounts (performance optimization)
  const accountMetricsMap = React.useMemo(() => {
    const map = new Map<string, {
      totalOpportunities: number;
      openOpportunities: number;
      wonOpportunities: number;
      openPipelineValue: number;
      wonValue: number;
      totalPaid: number;
      outstanding: number;
    }>();

    if (!opportunities || !accounts) return map;

    // Initialize all accounts
    accounts.forEach((account: Account) => {
      const accountId = account.id || account.Id;
      if (!accountId) return;
      map.set(accountId, {
        totalOpportunities: 0,
        openOpportunities: 0,
        wonOpportunities: 0,
        openPipelineValue: 0,
        wonValue: 0,
        totalPaid: 0,
        outstanding: 0,
      });
    });

    // Calculate metrics in one pass
    opportunities.forEach((opp: Opportunity) => {
      const metrics = map.get(opp.AccountId);
      if (!metrics) return;

      metrics.totalOpportunities++;

      const isOpen = OPEN_STAGES.includes(opp.StageName);
      const isWon = opp.StageName.includes('Closed Won') ||
                    opp.StageName.includes('Closed / Completed') ||
                    opp.StageName.includes('Collecting') ||
                    opp.StageName.includes('In Collection');

      if (isOpen) {
        metrics.openOpportunities++;
        metrics.openPipelineValue += opp.Amount || 0;
      }
      if (isWon) {
        metrics.wonOpportunities++;
        metrics.wonValue += opp.Amount || 0;
        metrics.totalPaid += opp.npe01__Payments_Made__c || 0;
        metrics.outstanding += (opp.Amount || 0) - (opp.npe01__Payments_Made__c || 0);
      }
    });

    return map;
  }, [opportunities, accounts]);

  const getAccountMetrics = (accountId: string) => {
    return accountMetricsMap.get(accountId) || {
      totalOpportunities: 0,
      openOpportunities: 0,
      wonOpportunities: 0,
      openPipelineValue: 0,
      wonValue: 0,
      totalPaid: 0,
      outstanding: 0,
    };
  };

  const handleAccountClick = (account: Account) => {
    setSelectedAccount(account);
    setDialogOpen(true);
    setActiveTab(0);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setSelectedAccount(null);
  };

  const handleCreateAccount = () => {
    if (!newAccountData.Name.trim()) {
      toast.error('Account name is required');
      return;
    }
    createAccountMutation.mutate(newAccountData);
  };

  // ── Inline save handler — used by schemaColumns InlineEditable cells. ───

  const handleSaveField = useCallback(
    async (recordId: string, field: string, newValue: unknown) => {
      const loadingToast = toast.loading('Saving to Salesforce...');
      try {
        await apiService.updateAccount(recordId, { [field]: newValue as any });
        toast.success('Saved!', { id: loadingToast, duration: 2000 });
        // Invalidate after a short delay so SF's workflow side-effects settle
        // before we re-query (mirrors the prior handleCellEdit cadence).
        setTimeout(() => {
          queryClient.invalidateQueries('accounts');
          queryClient.invalidateQueries('opportunities-for-accounts');
        }, 1000);
      } catch (error: any) {
        toast.error(`Failed: ${error.response?.data?.detail || error.message}`, { id: loadingToast });
        throw error; // re-throw so InlineEditable surfaces the error inline
      }
    },
    [queryClient],
  );

  // ── Schema-driven columns ────────────────────────────────────────────────

  const schemaColumns = useMemo(() => {
    if (!schemaData?.fields) return [];
    return buildSchemaColumns(schemaData.fields as SchemaField[], {
      entityType: 'Account',
      onSaveField: handleSaveField,
      canEditObject: canEdit,
      sfUserId,
      accounts,
      users: usersData ?? [],
      // Account has no edit-all permission key in PERMISSION_KEYS — only
      // admins or the record owner may edit (main.py:_enforce_record_ownership).
      overrides: new Map([
        ['Name', {
          flex: 2,
          minWidth: 250,
          renderCell: (params: GridRenderCellParams) => (
            <Box
              sx={{
                cursor: 'pointer',
                color: 'primary.main',
                fontWeight: 600,
                '&:hover': { textDecoration: 'underline' },
              }}
              onClick={() => handleAccountClick(params.row)}
            >
              {params.value || params.row.Name || params.row.name}
            </Box>
          ),
        }],
      ]),
    });
  }, [schemaData, handleSaveField, canEdit, sfUserId, accounts, usersData]);

  // Assemble the final columns: computed columns + schema columns + edit action
  const columns = useMemo(() => {
    // Dim dash for 0-valued aggregations. Keeps the column sortable (sortComparator
    // still sees the underlying 0) while visually breaking the sea of zeros that
    // dominates the grid when households without opportunities are in the list.
    const zeroDash = (
      <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
    );

    const computed: GridColDef[] = [
      {
        field: 'totalOpportunities',
        headerName: 'Total Opps',
        flex: 0.7,
        minWidth: 100,
        type: 'number',
        filterable: true,
        valueGetter: (params: GridValueGetterParams) => {
          return getAccountMetrics(params.row.id || params.row.Id).totalOpportunities;
        },
        renderCell: (params: GridRenderCellParams) => (
          (params.value as number) > 0 ? <span>{params.value as number}</span> : zeroDash
        ),
      },
      {
        field: 'openOpportunities',
        headerName: 'Open',
        flex: 0.6,
        minWidth: 80,
        type: 'number',
        filterable: true,
        valueGetter: (params: GridValueGetterParams) => {
          return getAccountMetrics(params.row.id || params.row.Id).openOpportunities;
        },
        renderCell: (params: GridRenderCellParams) => (
          (params.value as number) > 0
            ? <Chip label={params.value} color="primary" size="small" />
            : zeroDash
        ),
      },
      {
        field: 'wonOpportunities',
        headerName: 'Won',
        flex: 0.6,
        minWidth: 80,
        type: 'number',
        filterable: true,
        valueGetter: (params: GridValueGetterParams) => {
          return getAccountMetrics(params.row.id || params.row.Id).wonOpportunities;
        },
        renderCell: (params: GridRenderCellParams) => (
          (params.value as number) > 0
            ? <Chip label={params.value} color="success" size="small" />
            : zeroDash
        ),
      },
      {
        field: 'openPipelineValue',
        headerName: 'Open Pipeline',
        flex: 1,
        minWidth: 130,
        type: 'number',
        filterable: true,
        valueGetter: (params: GridValueGetterParams) => {
          return getAccountMetrics(params.row.id || params.row.Id).openPipelineValue;
        },
        renderCell: (params: GridRenderCellParams) => (
          (params.value as number) > 0
            ? <Box sx={{ color: 'primary.main', fontWeight: 600 }}>{formatDollarMillions(params.value as number)}</Box>
            : zeroDash
        ),
      },
      {
        field: 'wonValue',
        headerName: 'Amount Won',
        flex: 1,
        minWidth: 130,
        type: 'number',
        filterable: true,
        valueGetter: (params: GridValueGetterParams) => {
          return getAccountMetrics(params.row.id || params.row.Id).wonValue;
        },
        renderCell: (params: GridRenderCellParams) => (
          (params.value as number) > 0
            ? <Box sx={{ color: 'success.main', fontWeight: 600 }}>{formatDollarMillions(params.value as number)}</Box>
            : zeroDash
        ),
      },
      {
        field: 'totalPaid',
        headerName: 'Received',
        flex: 1,
        minWidth: 130,
        type: 'number',
        filterable: true,
        valueGetter: (params: GridValueGetterParams) => {
          return getAccountMetrics(params.row.id || params.row.Id).totalPaid;
        },
        renderCell: (params: GridRenderCellParams) => (
          (params.value as number) > 0
            ? <Box sx={{ color: 'success.main', fontWeight: 600 }}>{formatDollarMillions(params.value as number)}</Box>
            : zeroDash
        ),
      },
      {
        field: 'outstanding',
        headerName: 'Outstanding',
        flex: 1,
        minWidth: 130,
        type: 'number',
        filterable: true,
        valueGetter: (params: GridValueGetterParams) => {
          return getAccountMetrics(params.row.id || params.row.Id).outstanding;
        },
        renderCell: (params: GridRenderCellParams) => (
          (params.value as number) > 0
            ? <Box sx={{ color: 'warning.main', fontWeight: 600 }}>{formatDollarMillions(params.value as number)}</Box>
            : zeroDash
        ),
      },
    ];

    const action = editActionColumn(
      (row) => { setEditAccountId(row.Id || row.id); setEditDialogOpen(true); },
      { disabled: !canEdit, tooltip: canEdit ? 'Edit account' : 'No edit permission' }
    );

    return [...computed, ...schemaColumns, action];
  }, [schemaColumns, canEdit, accountMetricsMap, getAccountMetrics]);

  // ── Column visibility: set defaults when schema loads for the first time ─

  useEffect(() => {
    if (!schemaData?.fields) return;
    const hasStoredPrefs = !!localStorage.getItem(COLUMN_STORAGE_KEY);
    if (hasStoredPrefs) return;

    const model: GridColumnVisibilityModel = {};
    (schemaData.fields as SchemaField[]).forEach((field) => {
      if (field.name.includes('.')) return;
      model[field.name] = DEFAULT_VISIBLE_ACCOUNTS.has(field.name);
    });
    // Computed columns always visible by default
    DEFAULT_VISIBLE_ACCOUNTS.forEach((name) => { model[name] = true; });
    setColumnVisibilityModel(model);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(model));
  }, [schemaData]);

  const handleColumnVisibilityChange = useCallback((newModel: GridColumnVisibilityModel) => {
    setColumnVisibilityModel(newModel);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(newModel));
  }, []);

  // Get opportunities for selected account
  const accountOpportunities = selectedAccount
    ? opportunities?.filter((opp: Opportunity) => opp.AccountId === (selectedAccount.id || selectedAccount.Id)) || []
    : [];

  const openOpps = accountOpportunities.filter((opp: Opportunity) =>
    OPEN_STAGES.includes(opp.StageName)
  );
  const wonOpps = accountOpportunities.filter((opp: Opportunity) =>
    opp.StageName.includes('Closed Won') ||
    opp.StageName.includes('Closed / Completed') ||
    opp.StageName.includes('Collecting') ||
    opp.StageName.includes('In Collection')
  );

  // Opportunity columns for detail view
  const opportunityColumns: GridColDef[] = [
    {
      field: 'Name',
      headerName: 'Opportunity',
      flex: 2,
      minWidth: 200,
    },
    {
      field: 'StageName',
      headerName: 'Stage',
      flex: 1,
      minWidth: 150,
      renderCell: (params: GridRenderCellParams) => (
        <Chip
          label={params.value}
          size="small"
          sx={{ bgcolor: getStageHexColor(params.value as string), color: '#fff', fontWeight: 600 }}
        />
      ),
    },
    // Opportunity.Type column removed (BUG-UI-9) — duplicated RenewalRepeat__c.
    {
      field: 'Amount',
      headerName: 'Amount',
      flex: 0.8,
      minWidth: 120,
      valueFormatter: (params) => formatDollarMillions(params.value as number),
    },
    {
      field: 'Probability',
      headerName: 'Probability',
      flex: 0.7,
      minWidth: 100,
      renderCell: (params: GridRenderCellParams) => `${params.value}%`,
    },
    {
      field: 'CloseDate',
      headerName: 'Close Date',
      flex: 0.9,
      minWidth: 120,
      valueFormatter: (params) => {
        if (!params.value) return 'N/A';
        return format(new Date(params.value as string), 'MMM dd, yyyy');
      },
    },
    {
      field: 'npe01__Payments_Made__c',
      headerName: 'Received',
      flex: 0.9,
      minWidth: 120,
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ color: 'success.main', fontWeight: 600 }}>
          {formatDollarMillions((params.value as number) || 0)}
        </Box>
      ),
    },
  ];

  const metrics = selectedAccount ? getAccountMetrics(selectedAccount.id || selectedAccount.Id || '') : null;

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h4">Funders & Accounts</Typography>
          <Typography variant="body2" color="textSecondary">
            View all funding sources and their grant activity
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            startIcon={<AddIcon />}
            onClick={() => setCreateAccountDialogOpen(true)}
            variant="contained"
            color="primary"
          >
            New Account
          </Button>
          <Button
            startIcon={<RefreshIcon />}
            onClick={() => queryClient.invalidateQueries('accounts')}
            variant="outlined"
          >
            Refresh
          </Button>
        </Box>
      </Box>

      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>Click any account name</strong> to see detailed opportunity history and payment tracking.
      </Alert>

      {/* Accounts Table */}
      <Card>
        <CardContent>
          <Box sx={{ height: 'calc(100vh - 400px)', minHeight: 600, width: '100%' }}>
            <DataGrid
              rows={accounts || []}
              columns={columns}
              loading={accountsLoading || oppsLoading}
              getRowId={(row) => row.id || row.Id}
              columnVisibilityModel={columnVisibilityModel}
              onColumnVisibilityModelChange={handleColumnVisibilityChange}
              pagination
              pageSizeOptions={[25, 50, 100, 250, 500]}
              slots={{ toolbar: GridToolbar }}
              slotProps={{
                toolbar: {
                  showQuickFilter: true,
                  quickFilterProps: { debounceMs: 500 },
                  printOptions: { disableToolbarButton: true },
                  csvOptions: { disableToolbarButton: true },
                },
              }}
              initialState={{
                pagination: {
                  paginationModel: { pageSize: 100, page: 0 },
                },
                // Default to "most active first" so accounts with real pipeline
                // surface above the sea of dormant household records. Users can
                // click any column header (incl. Name) to re-sort.
                sorting: {
                  sortModel: [{ field: 'openPipelineValue', sort: 'desc' }],
                },
                ...(searchFromUrl ? {
                  filter: { filterModel: { items: [], quickFilterValues: [searchFromUrl] } },
                } : {}),
              }}
              filterMode="client"
              sortingMode="client"
              paginationMode="client"
              disableRowSelectionOnClick
              disableColumnFilter={false}
              disableColumnMenu={false}
              sortingOrder={['asc', 'desc']}
              sx={{
                '& .MuiDataGrid-cell:focus': { outline: 'none' },
                '& .MuiDataGrid-cell--editable': {
                  cursor: 'pointer',
                  bgcolor: 'background.paper',
                  '&:hover': { backgroundColor: 'action.hover', boxShadow: 'inset 0 0 0 1px rgba(25, 118, 210, 0.5)' },
                },
                '& .MuiDataGrid-cell--editing': { backgroundColor: 'primary.light', boxShadow: 'inset 0 0 0 2px #1976d2' },
                '& .MuiDataGrid-row:hover .MuiDataGrid-cell--editable': { backgroundColor: 'action.hover' },
              }}
            />
          </Box>
        </CardContent>
      </Card>

      {/* Account Detail Dialog */}
      <Dialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        maxWidth="lg"
        fullWidth
      >
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <BusinessIcon />
            <Box>
              <Typography variant="h6">{selectedAccount?.Name}</Typography>
              {selectedAccount?.Industry && (
                <Typography variant="caption" color="textSecondary">
                  {selectedAccount.Industry}
                </Typography>
              )}
            </Box>
          </Box>
        </DialogTitle>
        <DialogContent>
          {/* Summary Metrics */}
          {metrics && (
            <Grid container spacing={2} sx={{ mb: 3 }}>
              <Grid item xs={12} sm={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <BusinessIcon color="primary" fontSize="small" sx={{ mr: 1 }} />
                      <Typography variant="caption" color="textSecondary">
                        Total Opportunities
                      </Typography>
                    </Box>
                    <Typography variant="h5">{metrics.totalOpportunities}</Typography>
                    <Typography variant="caption">
                      {metrics.openOpportunities} open, {metrics.wonOpportunities} won
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <TrendingUpIcon color="primary" fontSize="small" sx={{ mr: 1 }} />
                      <Typography variant="caption" color="textSecondary">
                        Open Pipeline
                      </Typography>
                    </Box>
                    <Typography variant="h5" color="primary">{formatDollarMillions(metrics.openPipelineValue)}</Typography>
                    <Typography variant="caption">Active opportunities</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Card variant="outlined" sx={{ bgcolor: 'success.50' }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <TrendingUpIcon color="success" fontSize="small" sx={{ mr: 1 }} />
                      <Typography variant="caption" color="textSecondary">
                        Amount Won
                      </Typography>
                    </Box>
                    <Typography variant="h5" color="success.main">{formatDollarMillions(metrics.wonValue)}</Typography>
                    <Typography variant="caption">Closed/won grants</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <PaymentIcon color="success" fontSize="small" sx={{ mr: 1 }} />
                      <Typography variant="caption" color="textSecondary">
                        Received
                      </Typography>
                    </Box>
                    <Typography variant="h5" color="success.main">
                      {formatCurrency(metrics.totalPaid)}
                    </Typography>
                    <Typography variant="caption">Payments to date</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Card variant="outlined">
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                      <PaymentIcon color="warning" fontSize="small" sx={{ mr: 1 }} />
                      <Typography variant="caption" color="textSecondary">
                        Outstanding
                      </Typography>
                    </Box>
                    <Typography variant="h5" color="warning.main">
                      {formatCurrency(metrics.outstanding)}
                    </Typography>
                    <Typography variant="caption">Still pending</Typography>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
          )}

          {/* Tabs */}
          <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
            <Tabs value={activeTab} onChange={(e, newValue) => setActiveTab(newValue)}>
              <Tab label={`All Opportunities (${accountOpportunities.length})`} />
              <Tab label={`Open Pipeline (${openOpps.length})`} />
              <Tab label={`Won/Collecting (${wonOpps.length})`} />
              <Tab label="Contacts" icon={<PersonIcon />} iconPosition="start" />
              <Tab label="Activities" icon={<HistoryIcon />} iconPosition="start" />
              <Tab label={`Slack Activity (${slackActivity?.total || 0})`} icon={<ChatIcon />} iconPosition="start" />
              <Tab label={`Fireflies Meetings (${firefliesActivity?.total || 0})`} icon={<VideoCallIcon />} iconPosition="start" />
            </Tabs>
          </Box>

          {/* Opportunities List */}
          {activeTab < 3 && (
            <Box sx={{ height: 400 }}>
              <DataGrid
                rows={
                  activeTab === 0
                    ? accountOpportunities
                    : activeTab === 1
                    ? openOpps
                    : wonOpps
                }
                columns={opportunityColumns}
                getRowId={(row) => row.Id}
                hideFooter={accountOpportunities.length <= 10}
                pageSizeOptions={[10, 25, 50]}
                initialState={{
                  pagination: {
                    paginationModel: { pageSize: 10, page: 0 },
                  },
                  sorting: {
                    sortModel: [{ field: 'CloseDate', sort: 'desc' }],
                  },
                }}
                sortingMode="client"
                paginationMode="client"
                filterMode="client"
                disableRowSelectionOnClick
                disableColumnFilter={false}
                disableColumnMenu={false}
              />
            </Box>
          )}

          {/* Contacts List */}
          {activeTab === 3 && (
            <Box sx={{ height: 400, overflow: 'auto' }}>
              {contactsLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  <Typography>Loading contacts...</Typography>
                </Box>
              ) : !accountContacts || accountContacts.length === 0 ? (
                <Alert severity="info" sx={{ mt: 2 }}>
                  No contacts found for this account.
                </Alert>
              ) : (
                <Grid container spacing={2}>
                  {accountContacts.map((contact: Contact) => (
                    <Grid item xs={12} sm={6} md={4} key={contact.Id}>
                      <Card variant="outlined">
                        <CardContent>
                          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                            <PersonIcon color="primary" sx={{ mr: 1 }} />
                            <Typography variant="h6" component="div">
                              {contact.Name}
                            </Typography>
                          </Box>
                          {contact.Title && (
                            <Typography variant="body2" color="textSecondary" gutterBottom>
                              {contact.Title}
                            </Typography>
                          )}
                          {contact.npsp__Primary_Affiliation__r?.Name && (
                            <Typography variant="body2" color="textSecondary" gutterBottom>
                              🏢 {contact.npsp__Primary_Affiliation__r.Name}
                            </Typography>
                          )}
                          {contact.Email && (
                            <Typography variant="body2" sx={{ mt: 1 }}>
                              📧 {contact.Email}
                            </Typography>
                          )}
                          {contact.Phone && (
                            <Typography variant="body2">
                              📞 {contact.Phone}
                            </Typography>
                          )}
                        </CardContent>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              )}
            </Box>
          )}

          {/* Activities Timeline */}
          {activeTab === 4 && selectedAccount && (
            <Box sx={{ height: 400 }}>
              <ActivityTimeline
                accountId={selectedAccount.Id || selectedAccount.id}
                maxHeight={380}
              />
            </Box>
          )}

          {/* Slack Activity */}
          {activeTab === 5 && (
            <Box sx={{ height: 400, overflow: 'auto' }}>
              {slackActivity?.configured === false ? (
                <Alert severity="info" sx={{ mt: 2 }}>
                  <strong>Slack Not Configured</strong>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    To see Slack activity, set the SLACK_BOT_TOKEN environment variable and restart the backend server.
                  </Typography>
                </Alert>
              ) : slackLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  <Typography>Loading Slack messages...</Typography>
                </Box>
              ) : !slackActivity || slackActivity.messages.length === 0 ? (
                <Alert severity="info" sx={{ mt: 2 }}>
                  No Slack messages found mentioning "{selectedAccount?.Name}"
                </Alert>
              ) : (
                <Box>
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                    {slackActivity.total} message{slackActivity.total !== 1 ? 's' : ''} found mentioning this account
                  </Typography>
                  {slackActivity.messages.map((msg: SlackMessage, index: number) => (
                    <Card key={index} sx={{ mb: 2 }}>
                      <CardContent>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Chip label={`#${msg.channel}`} size="small" color="primary" variant="outlined" />
                            {msg.match_type === 'channel' && (
                              <Chip
                                label="Dedicated Channel"
                                size="small"
                                color="success"
                                variant="filled"
                              />
                            )}
                            {msg.match_type === 'mention' && (
                              <Chip
                                label="Mentioned"
                                size="small"
                                color="info"
                                variant="outlined"
                              />
                            )}
                            <Typography variant="caption" color="textSecondary">
                              by {msg.user}
                            </Typography>
                          </Box>
                          {msg.date && (
                            <Typography variant="caption" color="textSecondary">
                              {format(new Date(msg.date), 'MMM dd, yyyy h:mm a')}
                            </Typography>
                          )}
                        </Box>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
                          {msg.text}
                        </Typography>
                        {msg.permalink && (
                          <Button
                            size="small"
                            href={msg.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            startIcon={<ChatIcon />}
                          >
                            View in Slack
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </Box>
              )}
            </Box>
          )}

          {/* Fireflies Meetings */}
          {activeTab === 6 && (
            <Box sx={{ height: 400, overflow: 'auto' }}>
              {firefliesActivity?.configured === false ? (
                <Alert severity="info" sx={{ mt: 2 }}>
                  <strong>Fireflies Not Configured</strong>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    To see Fireflies meetings, set the FIREFLIES_API_KEY environment variable and restart the backend server.
                  </Typography>
                </Alert>
              ) : firefliesLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  <Typography>Loading meeting transcripts...</Typography>
                </Box>
              ) : !firefliesActivity || firefliesActivity.meetings.length === 0 ? (
                <Alert severity="info" sx={{ mt: 2 }}>
                  No Fireflies meetings found related to "{selectedAccount?.Name}"
                </Alert>
              ) : (
                <Box>
                  <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                    {firefliesActivity.total} meeting{firefliesActivity.total !== 1 ? 's' : ''} found related to this account
                  </Typography>
                  {firefliesActivity.meetings.map((meeting: FirefliesMeeting, index: number) => (
                    <Card key={index} sx={{ mb: 3, boxShadow: 3 }}>
                      <CardContent>
                        {/* Header: Title and Date */}
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2, pb: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
                          <Typography variant="h6" sx={{ fontWeight: 600, color: 'primary.main' }}>
                            {meeting.title}
                          </Typography>
                          {meeting.date && (
                            <Box sx={{ textAlign: 'right', ml: 2 }}>
                              <Typography variant="body2" color="textSecondary">
                                {format(new Date(meeting.date), 'MMM dd, yyyy')}
                              </Typography>
                              {meeting.duration && (
                                <Typography variant="caption" color="textSecondary">
                                  {Math.round(meeting.duration / 60)} minutes
                                </Typography>
                              )}
                            </Box>
                          )}
                        </Box>

                        {/* Attendees Section */}
                        {meeting.attendees && meeting.attendees.length > 0 && (
                          <Box sx={{ mb: 3 }}>
                            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600, color: 'text.primary' }}>
                              👥 Attendees ({meeting.attendees.length})
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                              {meeting.attendees.map((attendee, idx) => (
                                <Chip
                                  key={idx}
                                  label={attendee.name || attendee.email}
                                  size="small"
                                  icon={<PersonIcon />}
                                  sx={{
                                    bgcolor: 'primary.light',
                                    color: 'primary.contrastText',
                                    fontWeight: 500
                                  }}
                                />
                              ))}
                            </Box>
                          </Box>
                        )}

                        {/* Meeting Summary in Scrollable Box */}
                        {meeting.overview && (
                          <Box sx={{ mb: 3 }}>
                            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600, color: 'text.primary' }}>
                              📝 Meeting Summary
                            </Typography>
                            <Box
                              sx={{
                                p: 2,
                                bgcolor: 'grey.50',
                                borderRadius: 2,
                                border: '1px solid',
                                borderColor: 'grey.200',
                                maxHeight: '200px',
                                overflowY: 'auto',
                                '&::-webkit-scrollbar': {
                                  width: '8px',
                                },
                                '&::-webkit-scrollbar-track': {
                                  bgcolor: 'grey.100',
                                  borderRadius: '4px',
                                },
                                '&::-webkit-scrollbar-thumb': {
                                  bgcolor: 'grey.400',
                                  borderRadius: '4px',
                                  '&:hover': {
                                    bgcolor: 'grey.500',
                                  },
                                },
                              }}
                            >
                              <Typography variant="body2" sx={{ whiteSpace: 'pre-line', lineHeight: 1.6 }}>
                                {meeting.overview}
                              </Typography>
                            </Box>
                          </Box>
                        )}

                        {/* Action Items */}
                        {meeting.action_items && (
                          <Box sx={{ mb: 3 }}>
                            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600, color: 'text.primary' }}>
                              ✅ Action Items
                            </Typography>
                            <Box
                              sx={{
                                p: 2,
                                bgcolor: '#fff8e1',
                                borderRadius: 2,
                                border: '1px solid',
                                borderColor: '#ffb74d',
                              }}
                            >
                              {typeof meeting.action_items === 'string' ? (
                                <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
                                  {meeting.action_items}
                                </Typography>
                              ) : Array.isArray(meeting.action_items) && meeting.action_items.length > 0 ? (
                                <ul style={{ margin: 0, paddingLeft: '20px' }}>
                                  {meeting.action_items.map((item, idx) => (
                                    <li key={idx}>
                                      <Typography variant="body2">{item}</Typography>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </Box>
                          </Box>
                        )}

                        {/* Keywords */}
                        {meeting.keywords && meeting.keywords.length > 0 && (
                          <Box sx={{ mb: 3 }}>
                            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600, color: 'text.primary' }}>
                              🏷️ Keywords
                            </Typography>
                            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                              {meeting.keywords.map((keyword, idx) => (
                                <Chip key={idx} label={keyword} size="small" color="info" variant="outlined" />
                              ))}
                            </Box>
                          </Box>
                        )}

                        {/* View Full Transcript Button */}
                        <Box sx={{ display: 'flex', gap: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                          {meeting.fireflies_url && (
                            <Button
                              size="medium"
                              href={meeting.fireflies_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              startIcon={<VideoCallIcon />}
                              variant="contained"
                              color="primary"
                            >
                              View in Fireflies
                            </Button>
                          )}
                        </Box>
                      </CardContent>
                    </Card>
                  ))}
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Account Edit Dialog */}
      <AccountEditDialog
        open={editDialogOpen}
        onClose={() => { setEditDialogOpen(false); setEditAccountId(null); }}
        accountId={editAccountId}
        onSaved={() => {
          setEditDialogOpen(false);
          setEditAccountId(null);
        }}
      />

      {/* Create Account Dialog */}
      <Dialog open={createAccountDialogOpen} onClose={() => setCreateAccountDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create New Account</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Account Name"
              fullWidth
              required
              value={newAccountData.Name}
              onChange={(e) => setNewAccountData({ ...newAccountData, Name: e.target.value })}
              placeholder="e.g., Ford Foundation"
            />

            <TextField
              label="Type"
              fullWidth
              select
              value={newAccountData.Type}
              onChange={(e) => setNewAccountData({ ...newAccountData, Type: e.target.value })}
              helperText="What type of organization is this?"
            >
              <MenuItem value="">None</MenuItem>
              <MenuItem value="Foundation">Foundation</MenuItem>
              <MenuItem value="Corporate">Corporate</MenuItem>
              <MenuItem value="Government">Government</MenuItem>
              <MenuItem value="Individual">Individual</MenuItem>
              <MenuItem value="Other">Other</MenuItem>
            </TextField>

            <TextField
              label="Website"
              fullWidth
              value={newAccountData.Website}
              onChange={(e) => setNewAccountData({ ...newAccountData, Website: e.target.value })}
              placeholder="https://example.org"
            />

            <TextField
              label="Phone"
              fullWidth
              value={newAccountData.Phone}
              onChange={(e) => setNewAccountData({ ...newAccountData, Phone: e.target.value })}
              placeholder="(555) 123-4567"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateAccountDialogOpen(false)}>Cancel</Button>
          <ConfirmSaveButton
            onConfirm={handleCreateAccount}
            loading={createAccountMutation.isLoading}
            startIcon={<SaveIcon />}
            confirmTitle="Create in Salesforce?"
            confirmMessage="This will create a new account in Salesforce. Changes are tracked in field history."
          >
            Create Account
          </ConfirmSaveButton>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Accounts;
