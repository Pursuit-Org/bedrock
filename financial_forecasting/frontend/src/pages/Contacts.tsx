import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Grid,
  CircularProgress,
  Alert,
  Autocomplete,
} from '@mui/material';
import {
  Person as PersonIcon,
  Add as AddIcon,
  Refresh as RefreshIcon,
  Save as SaveIcon,
  Business as BusinessIcon,
} from '@mui/icons-material';
import {
  DataGrid,
  GridColDef,
  GridRenderCellParams,
  GridToolbar,
  GridColumnVisibilityModel,
} from '@mui/x-data-grid';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import ConfirmSaveButton from '../components/ConfirmSaveButton';
import { buildSchemaColumns, SchemaField } from '../utils/schemaColumns';
import { editActionColumn } from '../components/EditRowButton';
import ContactEditDialog from '../components/ContactEditDialog';
import { useDialogStack } from '../contexts/DialogStackContext';
import { usePermissions } from '../contexts/PermissionsContext';

import { apiService } from '../services/api';

interface Account {
  Id: string;
  Name: string;
  Type?: string;
}

const COLUMN_STORAGE_KEY = 'bedrock:columns:contacts';

const DEFAULT_VISIBLE_CONTACTS = new Set([
  'FirstName', 'LastName', 'AccountId', 'Title',
  'npsp__Primary_Affiliation__c', 'Email', 'Phone', '__edit__',
]);

const Contacts: React.FC = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editContactId, setEditContactId] = useState<string | null>(null);
  const [newContactData, setNewContactData] = useState({
    FirstName: '',
    LastName: '',
    npsp__Primary_Affiliation__c: '', // Organization where they work
    Title: '',
    Email: '',
    Phone: '',
  });

  const queryClient = useQueryClient();
  const { can, isAdmin, sfUserId } = usePermissions();
  const canEdit = isAdmin || can('edit_contacts');
  const { pushDialog } = useDialogStack();
  const [searchParams] = useSearchParams();
  const searchFromUrl = searchParams.get('search') || '';

  // Fetch all contacts
  const { data: contactsData, isLoading: contactsLoading, error: contactsError } = useQuery(
    'all-contacts',
    async () => {
      const response = await apiService.getContacts();
      return response.data;
    },
    {
      onError: (error: any) => {
        console.error('Error fetching contacts:', error);
        toast.error('Failed to load contacts: ' + (error.response?.data?.detail || error.message));
      }
    }
  );

  // Fetch accounts for dropdown + schema-driven AccountId reference autocomplete.
  const { data: accountsData, isLoading: accountsLoading } = useQuery(
    'accounts',
    async () => {
      const response = await apiService.getAccounts();
      return response.data;
    }
  );

  // Fetch users for schema-driven OwnerId reference autocomplete.
  const { data: usersData } = useQuery(
    'users',
    async () => {
      const response = await apiService.getUsers({ limit: 1000 });
      return response.data ?? [];
    },
    { staleTime: 10 * 60 * 1000 },
  );

  // Fetch contact schema for dynamic columns
  const { data: contactSchemaData } = useQuery(
    'contact-schema',
    async () => {
      const response = await apiService.getSchemaDescribe('Contact');
      return response.data;
    },
    { staleTime: 30 * 60 * 1000 }
  );

  // Ensure contacts and accounts are always arrays
  const contacts = Array.isArray(contactsData) ? contactsData : (contactsData?.contacts || []);
  const accounts = Array.isArray(accountsData) ? accountsData : (accountsData?.accounts || []);

  // ── Inline save handler — used by schemaColumns InlineEditable cells. ───

  const handleSaveField = useCallback(
    async (recordId: string, field: string, newValue: unknown) => {
      const loadingToast = toast.loading('Saving to Salesforce...');
      try {
        await apiService.updateContact(recordId, { [field]: newValue as any });
        toast.success('Saved!', { id: loadingToast, duration: 2000 });
        setTimeout(() => {
          queryClient.invalidateQueries('all-contacts');
          queryClient.invalidateQueries(['account-contacts']);
        }, 1000);
      } catch (error: any) {
        toast.error(`Failed: ${error.response?.data?.detail || error.message}`, { id: loadingToast });
        throw error;
      }
    },
    [queryClient],
  );

  // ── Schema-driven columns ──────────────────────────────────────────────

  const schemaColumns = useMemo(() => {
    if (!contactSchemaData?.fields) return [];
    return buildSchemaColumns(contactSchemaData.fields as SchemaField[], {
      entityType: 'Contact',
      onSaveField: handleSaveField,
      canEditObject: canEdit,
      sfUserId,
      accounts,
      users: usersData ?? [],
      // Contact has no edit-all permission key — admin or owner only.
    });
  }, [contactSchemaData, handleSaveField, canEdit, sfUserId, accounts, usersData]);

  const columns = useMemo(() => {
    const action = editActionColumn(
      (row) => { setEditContactId(row.Id); setEditDialogOpen(true); },
      { disabled: !canEdit, tooltip: canEdit ? 'Edit contact' : 'No edit permission' }
    );
    return [...schemaColumns, action];
  }, [schemaColumns, canEdit]);

  // ── Column visibility persistence ──────────────────────────────────────

  const [columnVisibilityModel, setColumnVisibilityModel] = useState<GridColumnVisibilityModel>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return {};
  });

  useEffect(() => {
    if (!contactSchemaData?.fields) return;
    const hasStoredPrefs = !!localStorage.getItem(COLUMN_STORAGE_KEY);
    if (hasStoredPrefs) return;

    const model: GridColumnVisibilityModel = {};
    (contactSchemaData.fields as SchemaField[]).forEach((field) => {
      if (field.name.includes('.')) return;
      model[field.name] = DEFAULT_VISIBLE_CONTACTS.has(field.name);
    });
    model['__edit__'] = true;
    // Hide composite Name (it's a formula — FirstName + LastName are shown instead)
    model['Name'] = false;
    setColumnVisibilityModel(model);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(model));
  }, [contactSchemaData]);

  const handleColumnVisibilityChange = useCallback((newModel: GridColumnVisibilityModel) => {
    setColumnVisibilityModel(newModel);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(newModel));
  }, []);

  // Create contact mutation
  const createContactMutation = useMutation(
    async (data: any) => {
      const response = await apiService.createContact(data);
      return response.data;
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries('all-contacts');
        queryClient.invalidateQueries(['account-contacts']);
        toast.success('Contact created successfully!');
        setCreateDialogOpen(false);
        setNewContactData({
          FirstName: '',
          LastName: '',
          npsp__Primary_Affiliation__c: '',
          Title: '',
          Email: '',
          Phone: '',
        });
      },
      onError: (error: any) => {
        toast.error(error.response?.data?.detail || 'Failed to create contact');
      },
    }
  );

  const handleCreateContact = () => {
    if (!newContactData.LastName.trim()) {
      toast.error('Last name is required');
      return;
    }
    if (!newContactData.npsp__Primary_Affiliation__c) {
      toast.error('Primary Affiliation is required');
      return;
    }
    createContactMutation.mutate(newContactData);
  };

  const selectedAccount = accounts?.find((acc: Account) => acc.Id === newContactData.npsp__Primary_Affiliation__c);

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h4">Contacts</Typography>
          <Typography variant="body2" color="textSecondary">
            View and manage all contacts across funders
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            startIcon={<AddIcon />}
            onClick={() => setCreateDialogOpen(true)}
            variant="contained"
            color="primary"
          >
            New Contact
          </Button>
          <Button
            startIcon={<RefreshIcon />}
            onClick={() => queryClient.invalidateQueries('all-contacts')}
            variant="outlined"
          >
            Refresh
          </Button>
        </Box>
      </Box>

      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>All Contacts:</strong> Double-click any editable cell to edit inline. Click the edit
        icon for the full edit form. Customize visible columns via the Columns button in the toolbar.
      </Alert>

      {/* Error Display */}
      {contactsError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          Failed to load contacts. Please check your connection or try refreshing.
        </Alert>
      )}

      {/* No contacts message */}
      {!contactsLoading && !contactsError && contacts && contacts.length === 0 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <Typography variant="body1" gutterBottom>
            <strong>No contacts found</strong>
          </Typography>
          <Typography variant="body2">
            You don't have any contacts in your system yet. Click "New Contact" to create your first contact,
            or contacts will be automatically added when you create them during opportunity creation.
          </Typography>
        </Alert>
      )}

      {/* Contacts Table */}
      <Card>
        <CardContent>
          <Box sx={{ height: 'calc(100vh - 400px)', minHeight: 600, width: '100%' }}>
            <DataGrid
              rows={contacts || []}
              columns={columns}
              loading={contactsLoading}
              getRowId={(row) => row.Id}
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
                pagination: { paginationModel: { pageSize: 100, page: 0 } },
                sorting: { sortModel: [{ field: 'LastName', sort: 'asc' }] },
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

      {/* Edit Contact Dialog */}
      <ContactEditDialog
        open={editDialogOpen}
        onClose={() => { setEditDialogOpen(false); setEditContactId(null); }}
        contactId={editContactId}
        onSaved={() => {
          setEditDialogOpen(false);
          setEditContactId(null);
        }}
        onOpenRelated={(type, id, label, parentInfo) => pushDialog({
          type, id, label, parent: parentInfo,
        })}
      />

      {/* Create Contact Dialog */}
      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create New Contact</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField
                  label="First Name"
                  fullWidth
                  value={newContactData.FirstName}
                  onChange={(e) => setNewContactData({ ...newContactData, FirstName: e.target.value })}
                  placeholder="John"
                />
              </Grid>
              <Grid item xs={6}>
                <TextField
                  label="Last Name"
                  fullWidth
                  required
                  value={newContactData.LastName}
                  onChange={(e) => setNewContactData({ ...newContactData, LastName: e.target.value })}
                  placeholder="Doe"
                />
              </Grid>
            </Grid>

            <Autocomplete
              options={accounts || []}
              getOptionLabel={(option: Account) => option.Name || ''}
              loading={accountsLoading}
              value={selectedAccount || null}
              onChange={(_, newValue) => {
                setNewContactData({ ...newContactData, npsp__Primary_Affiliation__c: newValue?.Id || '' });
              }}
              isOptionEqualToValue={(option, value) => option.Id === value.Id}
              filterOptions={(options, state) => {
                const inputValue = state.inputValue.toLowerCase();
                if (!inputValue) return options.slice(0, 100);
                return options.filter((option) =>
                  option.Name?.toLowerCase().includes(inputValue)
                ).slice(0, 50);
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Primary Affiliation (Company/Organization)"
                  placeholder="Type to search for their employer..."
                  required
                  helperText="Select the organization where this person works (e.g., foundation, company). Leave Account blank - a household account will be auto-created."
                />
              )}
              renderOption={(props, option: Account) => (
                <li {...props} key={option.Id}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <BusinessIcon fontSize="small" color="action" />
                    <Box>
                      <Typography variant="body2">{option.Name}</Typography>
                      {option.Type && (
                        <Typography variant="caption" color="textSecondary">
                          {option.Type}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                </li>
              )}
              noOptionsText="No accounts found"
            />

            <TextField
              label="Title"
              fullWidth
              value={newContactData.Title}
              onChange={(e) => setNewContactData({ ...newContactData, Title: e.target.value })}
              placeholder="e.g., Program Officer"
            />


            <TextField
              label="Email"
              fullWidth
              type="email"
              value={newContactData.Email}
              onChange={(e) => setNewContactData({ ...newContactData, Email: e.target.value })}
              placeholder="john.doe@example.org"
            />

            <TextField
              label="Phone"
              fullWidth
              value={newContactData.Phone}
              onChange={(e) => setNewContactData({ ...newContactData, Phone: e.target.value })}
              placeholder="(555) 123-4567"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
          <ConfirmSaveButton
            onConfirm={handleCreateContact}
            loading={createContactMutation.isLoading}
            startIcon={<SaveIcon />}
            confirmTitle="Create in Salesforce?"
            confirmMessage="This will create a new contact in Salesforce. Changes are tracked in field history."
          >
            Create Contact
          </ConfirmSaveButton>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Contacts;
