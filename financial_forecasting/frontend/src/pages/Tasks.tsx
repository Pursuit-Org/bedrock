import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Alert,
} from '@mui/material';
import {
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import {
  DataGrid,
  GridToolbar,
  GridColumnVisibilityModel,
} from '@mui/x-data-grid';
import { useQuery, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import { buildSchemaColumns, SchemaField } from '../utils/schemaColumns';
import { editActionColumn } from '../components/EditRowButton';
import TaskPanel from '../components/TaskPanel';
import { usePermissions } from '../contexts/PermissionsContext';

import { apiService } from '../services/api';

const COLUMN_STORAGE_KEY = 'bedrock:columns:tasks';

const DEFAULT_VISIBLE_TASKS = new Set([
  'Subject', 'Status', 'Priority', 'ActivityDate',
  'WhoId', 'OwnerId', '__edit__',
]);

const Tasks: React.FC = () => {
  const queryClient = useQueryClient();
  const { can, isAdmin, sfUserId } = usePermissions();
  const canEdit = isAdmin || can('edit_own_tasks');
  const [searchParams] = useSearchParams();
  const searchFromUrl = searchParams.get('search') || '';

  // ── TaskPanel state (edit action) ─────────────────────────────────────
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [selectedOrphanTask, setSelectedOrphanTask] = useState<any>(null);

  // ── Data queries ──────────────────────────────────────────────────────

  // Shares cache key with Layout.tsx — React Query dedupes, no extra API call
  const { data: tasksData, isLoading: tasksLoading, error: tasksError } = useQuery(
    ['my-tasks'],
    async () => {
      const response = await apiService.getMyTasks();
      return response.data?.data || response.data || [];
    },
    {
      staleTime: 5 * 60 * 1000,
      onError: (error: any) => {
        console.error('Error fetching tasks:', error);
        toast.error('Failed to load tasks: ' + (error.response?.data?.detail || error.message));
      },
    }
  );

  // Fetch task schema for dynamic columns
  const { data: taskSchemaData } = useQuery(
    'task-schema',
    async () => {
      const response = await apiService.getSchemaDescribe('Task');
      return response.data;
    },
    { staleTime: 30 * 60 * 1000 }
  );

  // Preload accounts + users for Task.WhatId / Task.OwnerId reference autocomplete.
  const { data: accountsData } = useQuery(
    'accounts',
    async () => {
      const response = await apiService.getAccounts();
      return response.data;
    },
    { staleTime: 10 * 60 * 1000 },
  );
  const { data: usersData } = useQuery(
    'users',
    async () => {
      const response = await apiService.getUsers({ limit: 1000 });
      return response.data ?? [];
    },
    { staleTime: 10 * 60 * 1000 },
  );

  const tasks = Array.isArray(tasksData) ? tasksData : [];
  const accounts = Array.isArray(accountsData) ? accountsData : (accountsData?.accounts || []);

  // ── Inline save handler — used by schemaColumns InlineEditable cells. ───

  const handleSaveField = useCallback(
    async (recordId: string, field: string, newValue: unknown) => {
      const loadingToast = toast.loading('Saving to Salesforce...');
      try {
        await apiService.updateTask(recordId, { [field]: newValue as any });
        toast.success('Saved!', { id: loadingToast, duration: 2000 });
        setTimeout(() => {
          queryClient.invalidateQueries(['my-tasks']);
        }, 1000);
      } catch (error: any) {
        toast.error(`Failed: ${error.response?.data?.detail || error.message}`, { id: loadingToast });
        throw error;
      }
    },
    [queryClient],
  );

  // ── Schema-driven columns ───────────────────────────────────────────

  const schemaColumns = useMemo(() => {
    if (!taskSchemaData?.fields) return [];
    return buildSchemaColumns(taskSchemaData.fields as SchemaField[], {
      entityType: 'Task',
      onSaveField: handleSaveField,
      canEditObject: canEdit,
      sfUserId,
      accounts,
      users: usersData ?? [],
      // Task has no edit-all permission key — admin or owner only.
    });
  }, [taskSchemaData, handleSaveField, canEdit, sfUserId, accounts, usersData]);

  const columns = useMemo(() => {
    const action = editActionColumn(
      (row) => {
        setSelectedOrphanTask({
          Id: row.Id,
          Subject: row.Subject,
          Status: row.Status,
          Priority: row.Priority,
          ActivityDate: row.ActivityDate,
          Description: row.Description || null,
          OwnerId: row.OwnerId,
          OwnerName: row.Owner?.Name || null,
          WhatId: row.WhatId || null,
        });
        setTaskPanelOpen(true);
      },
      { disabled: !canEdit, tooltip: canEdit ? 'Edit task' : 'No edit permission' }
    );
    return [...schemaColumns, action];
  }, [schemaColumns, canEdit]);

  // ── Column visibility persistence ──────────────────────────────────

  const [columnVisibilityModel, setColumnVisibilityModel] = useState<GridColumnVisibilityModel>(() => {
    try {
      const stored = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return {};
  });

  useEffect(() => {
    if (!taskSchemaData?.fields) return;
    const hasStoredPrefs = !!localStorage.getItem(COLUMN_STORAGE_KEY);
    if (hasStoredPrefs) return;

    const model: GridColumnVisibilityModel = {};
    (taskSchemaData.fields as SchemaField[]).forEach((field) => {
      if (field.name.includes('.')) return;
      model[field.name] = DEFAULT_VISIBLE_TASKS.has(field.name);
    });
    model['__edit__'] = true;
    setColumnVisibilityModel(model);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(model));
  }, [taskSchemaData]);

  const handleColumnVisibilityChange = useCallback((newModel: GridColumnVisibilityModel) => {
    setColumnVisibilityModel(newModel);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(newModel));
  }, []);

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h4">Tasks</Typography>
          <Typography variant="body2" color="textSecondary">
            Your open tasks — double-click editable cells to update inline
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            startIcon={<RefreshIcon />}
            onClick={() => queryClient.invalidateQueries(['my-tasks'])}
            variant="outlined"
          >
            Refresh
          </Button>
        </Box>
      </Box>

      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>My Tasks:</strong> Double-click any editable cell to edit inline. Click the edit
        icon to open the full task panel. Customize visible columns via the Columns button in the toolbar.
      </Alert>

      {/* Error Display */}
      {tasksError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          Failed to load tasks. Please check your connection or try refreshing.
        </Alert>
      )}

      {/* No tasks message */}
      {!tasksLoading && !tasksError && tasks.length === 0 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <Typography variant="body1" gutterBottom>
            <strong>No open tasks</strong>
          </Typography>
          <Typography variant="body2">
            You don't have any open tasks assigned to you. Tasks can be created from the Priorities page
            or from within an opportunity's task panel.
          </Typography>
        </Alert>
      )}

      {/* Tasks Table */}
      <Card>
        <CardContent>
          <Box sx={{ height: 'calc(100vh - 400px)', minHeight: 600, width: '100%' }}>
            <DataGrid
              rows={tasks}
              columns={columns}
              loading={tasksLoading}
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
                sorting: { sortModel: [{ field: 'ActivityDate', sort: 'asc' }] },
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

      {/* TaskPanel drawer for edit action */}
      <TaskPanel
        open={taskPanelOpen}
        onClose={() => { setTaskPanelOpen(false); setSelectedOrphanTask(null); }}
        opportunity={null}
        orphanTask={selectedOrphanTask}
      />
    </Box>
  );
};

export default Tasks;
