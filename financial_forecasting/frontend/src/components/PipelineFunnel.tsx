import React, { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Collapse,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  IconButton,
  CircularProgress,
  Tooltip,
  Button,
  Link,
  Select,
  MenuItem,
  FormControl,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Warning as StagnantIcon,
  AutoAwesome as AnalyzeIcon,
} from '@mui/icons-material';
import { useQuery, useQueryClient } from 'react-query';
import { format, parseISO, formatDistanceToNow, differenceInDays } from 'date-fns';
import { formatDollarMillions } from '../utils/formatters';
import { getStageHexColor } from '../types/salesforce';
import { apiService, PipelineAnalysisBody } from '../services/api';
import LookbackRangeSelector, {
  LookbackValue,
  lookbackToDays,
  formatLookbackLabel,
} from './LookbackRangeSelector';

import {
  ACTIVE_FUNNEL_STAGES,
  CLOSED_FUNNEL_STAGES,
  STAGE_IDX,
  WON_STAGES,
  LOST_STAGES,
  classifyTransition,
  TransitionKind,
} from './pipelineFunnelTransitions';

interface Opportunity {
  Id: string;
  Name: string;
  StageName: string;
  Amount: number;
  Probability: number;
  CloseDate: string;
  LastModifiedDate?: string;
  CreatedDate?: string;
  OwnerId?: string;
  Owner?: { Name: string };
}

interface StageChange {
  OpportunityId: string;
  OpportunityName: string;
  Amount: number;
  CurrentStage: string;
  OwnerId?: string;
  OldValue: string;
  NewValue: string;
  CreatedDate: string;
}

interface StageMovement {
  opportunityId: string;
  opportunityName: string;
  amount: number;
  fromStage: string;
  toStage: string;
  direction: TransitionKind;
  changedDate: string;
}

interface FunnelLayer {
  stage: string;
  count: number;
  totalAmount: number;
  advancedIn: StageMovement[];
  retreatedIn: StageMovement[];
  advancedOut: StageMovement[];
  retreatedOut: StageMovement[];
  wonOut: StageMovement[];
  lostOut: StageMovement[];
  throughput: number;
  stagnation: number;
}

interface PipelineFunnelProps {
  opportunities: Opportunity[];
  /** Page-level multi-select: when set, restricts the funnel to these owners. */
  selectedOwnerIds?: string[];
  /** Legacy single-owner prop, retained for compatibility. Equivalent to passing [ownerId] in selectedOwnerIds. */
  ownerId?: string;
}

function formatChangeDate(iso: string): string {
  try {
    return format(parseISO(iso), 'MMM d');
  } catch {
    return '';
  }
}

function buildFunnelData(opps: Opportunity[], history: StageChange[]): FunnelLayer[] {
  const stageMap = new Map<string, {
    count: number; total: number;
    advancedIn: StageMovement[]; retreatedIn: StageMovement[];
    advancedOut: StageMovement[]; retreatedOut: StageMovement[];
    wonOut: StageMovement[]; lostOut: StageMovement[];
  }>();

  for (const stage of ACTIVE_FUNNEL_STAGES) {
    stageMap.set(stage, {
      count: 0, total: 0,
      advancedIn: [], retreatedIn: [],
      advancedOut: [], retreatedOut: [],
      wonOut: [], lostOut: [],
    });
  }

  for (const opp of opps) {
    const entry = stageMap.get(opp.StageName);
    if (entry) {
      entry.count++;
      entry.total += opp.Amount || 0;
    }
  }

  const seen = new Set<string>();
  for (const change of history) {
    const key = `${change.OpportunityId}:${change.OldValue}->${change.NewValue}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = classifyTransition(change.OldValue, change.NewValue);
    const movement: StageMovement = {
      opportunityId: change.OpportunityId,
      opportunityName: change.OpportunityName || 'Unknown',
      amount: change.Amount || 0,
      fromStage: change.OldValue,
      toStage: change.NewValue,
      direction: kind,
      changedDate: change.CreatedDate || '',
    };

    const fromEntry = stageMap.get(change.OldValue);
    const toEntry = stageMap.get(change.NewValue);

    if (kind === 'forward') {
      if (fromEntry) fromEntry.advancedOut.push(movement);
      if (toEntry) toEntry.advancedIn.push(movement);
    } else if (kind === 'backward') {
      if (fromEntry) fromEntry.retreatedOut.push(movement);
      if (toEntry) toEntry.retreatedIn.push(movement);
    } else if (kind === 'won') {
      // Register the win on the layer the opp was in before closing.
      // No incoming side — terminal stage has no layer in the active funnel.
      if (fromEntry) fromEntry.wonOut.push(movement);
    } else {
      // Loss: same model as won — terminal, recorded on the from-layer only.
      if (fromEntry) fromEntry.lostOut.push(movement);
    }
  }

  return ACTIVE_FUNNEL_STAGES.map((stage) => {
    const e = stageMap.get(stage)!;
    const totalActivity =
      e.advancedIn.length + e.advancedOut.length +
      e.retreatedIn.length + e.retreatedOut.length +
      e.wonOut.length + e.lostOut.length;
    return {
      stage,
      count: e.count,
      totalAmount: e.total,
      advancedIn: e.advancedIn,
      retreatedIn: e.retreatedIn,
      advancedOut: e.advancedOut,
      retreatedOut: e.retreatedOut,
      wonOut: e.wonOut,
      lostOut: e.lostOut,
      throughput: e.advancedOut.length + e.wonOut.length,
      stagnation: e.count > 0 && totalActivity === 0 ? e.count : 0,
    };
  });
}

interface FlowRow {
  opportunityId: string;
  opportunityName: string;
  amount: number;
  label: string;
  stage: string;
  changedDate: string;
}

function buildProgressingRows(layer: FunnelLayer): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const m of layer.advancedOut) {
    rows.push({ opportunityId: m.opportunityId, opportunityName: m.opportunityName, amount: m.amount, label: 'Advanced to', stage: m.toStage, changedDate: m.changedDate });
  }
  for (const m of layer.advancedIn) {
    rows.push({ opportunityId: m.opportunityId, opportunityName: m.opportunityName, amount: m.amount, label: 'Entered from', stage: m.fromStage, changedDate: m.changedDate });
  }
  return rows;
}

function buildSetbackRows(layer: FunnelLayer): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const m of layer.retreatedIn) {
    rows.push({ opportunityId: m.opportunityId, opportunityName: m.opportunityName, amount: m.amount, label: 'Returned from', stage: m.fromStage, changedDate: m.changedDate });
  }
  for (const m of layer.retreatedOut) {
    rows.push({ opportunityId: m.opportunityId, opportunityName: m.opportunityName, amount: m.amount, label: 'Fell back to', stage: m.toStage, changedDate: m.changedDate });
  }
  return rows;
}

function buildWinRows(layer: FunnelLayer): FlowRow[] {
  return layer.wonOut.map((m) => ({
    opportunityId: m.opportunityId,
    opportunityName: m.opportunityName,
    amount: m.amount,
    label: 'Closed to',
    stage: m.toStage,
    changedDate: m.changedDate,
  }));
}

function buildLossRows(layer: FunnelLayer): FlowRow[] {
  return layer.lostOut.map((m) => ({
    opportunityId: m.opportunityId,
    opportunityName: m.opportunityName,
    amount: m.amount,
    label: 'Lost to',
    stage: m.toStage,
    changedDate: m.changedDate,
  }));
}

const PipelineFunnel: React.FC<PipelineFunnelProps> = ({ opportunities, selectedOwnerIds, ownerId }) => {
  const [lookback, setLookback] = useState<LookbackValue>({ preset: 'last30d' });
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  // Focus dropdown lets the user narrow the funnel to a single owner from the
  // current selection without changing the page-level multi-select.
  const [focusOwnerId, setFocusOwnerId] = useState<string>('all');

  // `days` drives the /stage-history fetch (endpoint accepts only days int).
  // For custom ranges this is a superset window; the overlay is then
  // client-filtered to [rangeStart, rangeEnd] below.
  const days = lookbackToDays(lookback);
  const rangeLabel = useMemo(() => formatLookbackLabel(lookback), [lookback]);

  // Owners visible in the focus dropdown are derived from the opportunities prop.
  // Sorted alphabetically, names resolved from Owner.Name relationship.
  const availableOwners = useMemo(() => {
    const seen = new Map<string, string>();
    for (const opp of opportunities) {
      if (opp.OwnerId && !seen.has(opp.OwnerId)) {
        seen.set(opp.OwnerId, opp.Owner?.Name || opp.OwnerId);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [opportunities]);

  // If the focused owner falls out of availableOwners (e.g., multi-select changed),
  // reset focus to "all" so the funnel doesn't appear empty.
  React.useEffect(() => {
    if (focusOwnerId !== 'all' && !availableOwners.some((o) => o.id === focusOwnerId)) {
      setFocusOwnerId('all');
    }
  }, [availableOwners, focusOwnerId]);

  // Resolve the effective filter set for both opportunities and history.
  // Order of precedence: focus dropdown > selectedOwnerIds prop > legacy ownerId prop > none.
  const effectiveOwnerIds = useMemo<Set<string> | null>(() => {
    if (focusOwnerId !== 'all') return new Set([focusOwnerId]);
    if (selectedOwnerIds && selectedOwnerIds.length > 0) return new Set(selectedOwnerIds);
    if (ownerId) return new Set([ownerId]);
    return null;
  }, [focusOwnerId, selectedOwnerIds, ownerId]);

  const { data: historyData, isLoading: historyLoading } = useQuery(
    ['stage-history', days],
    async () => {
      const response = await apiService.getStageHistory(days);
      return (response.data || []) as StageChange[];
    },
    { staleTime: 5 * 60 * 1000 }
  );

  const history = useMemo(() => {
    let out = historyData || [];
    if (effectiveOwnerIds) {
      out = out.filter((h) => h.OwnerId && effectiveOwnerIds.has(h.OwnerId));
    }
    // Client-side date narrowing only for custom ranges — presets are already
    // filtered exactly by the backend via LAST_N_DAYS:n. SF CreatedDate comes
    // back like "2026-04-01T10:00:00.000+0000"; parseISO handles the +0000
    // suffix (lexical compare against a "…Z" ISO string would break).
    if (lookback.preset === 'custom') {
      const rsMs = new Date(`${lookback.start}T00:00:00.000Z`).getTime();
      const reMs = new Date(`${lookback.end}T23:59:59.999Z`).getTime();
      out = out.filter((h) => {
        try {
          const t = parseISO(h.CreatedDate).getTime();
          return t >= rsMs && t <= reMs;
        } catch {
          return false;
        }
      });
    }
    return out;
  }, [historyData, effectiveOwnerIds, lookback]);

  const filteredOpps = useMemo(
    () =>
      opportunities.filter(
        (opp) =>
          ACTIVE_FUNNEL_STAGES.includes(opp.StageName as any) &&
          (!effectiveOwnerIds || (opp.OwnerId && effectiveOwnerIds.has(opp.OwnerId))),
      ),
    [opportunities, effectiveOwnerIds],
  );

  // Closed-stage opps — parallel to filteredOpps, same owner filter, but
  // scoped to the terminal stages we render below the active funnel.
  const closedOpps = useMemo(
    () =>
      opportunities.filter(
        (opp) =>
          CLOSED_FUNNEL_STAGES.includes(opp.StageName as any) &&
          (!effectiveOwnerIds || (opp.OwnerId && effectiveOwnerIds.has(opp.OwnerId))),
      ),
    [opportunities, effectiveOwnerIds],
  );

  const closedStageTotals = useMemo(() => {
    const totals = new Map<string, { count: number; total: number }>();
    for (const stage of CLOSED_FUNNEL_STAGES) totals.set(stage, { count: 0, total: 0 });
    for (const opp of closedOpps) {
      const entry = totals.get(opp.StageName);
      if (entry) {
        entry.count++;
        entry.total += opp.Amount || 0;
      }
    }
    return totals;
  }, [closedOpps]);

  const funnel = useMemo(() => buildFunnelData(filteredOpps, history), [filteredOpps, history]);

  const maxCount = Math.max(...funnel.map((l) => l.count), 1);

  const queryClient = useQueryClient();
  const [analysisRequested, setAnalysisRequested] = useState(false);

  // Owner IDs to send to the backend analyze endpoint. Sorted for stable
  // cache keys (so the same set hashes the same regardless of order).
  const analysisOwnerIds = useMemo(() => {
    if (!effectiveOwnerIds) return [] as string[];
    return Array.from(effectiveOwnerIds).sort();
  }, [effectiveOwnerIds]);

  // Request body for /api/ai/pipeline-analysis. Custom ranges send explicit
  // start/end (so the AI sees exactly what the overlay shows); presets send
  // days (so the server uses LAST_N_DAYS:n and hits the shared cache path).
  const analysisBody = useMemo<PipelineAnalysisBody>(() => {
    if (lookback.preset === 'custom') {
      return {
        start: lookback.start,
        end: lookback.end,
        owner_ids: analysisOwnerIds,
      };
    }
    return { days: lookbackToDays(lookback), owner_ids: analysisOwnerIds };
  }, [lookback, analysisOwnerIds]);

  const analysisCacheKey = useMemo(() => {
    const rangeKey =
      lookback.preset === 'custom'
        ? `custom:${lookback.start}:${lookback.end}`
        : `days:${lookbackToDays(lookback)}`;
    return ['pipeline-analysis', rangeKey, analysisOwnerIds.join(',')];
  }, [lookback, analysisOwnerIds]);

  const { data: analysisData, isLoading: analysisLoading, isFetching: analysisFetching } = useQuery(
    analysisCacheKey,
    async () => {
      const response = await apiService.analyzePipeline(analysisBody);
      return response.data as {
        analysis: string;
        generated_at: string;
        changes_count: number;
        days: number;
        start?: string | null;
        end?: string | null;
        owner_ids?: string[];
        owner_names?: string[];
      };
    },
    {
      enabled: analysisRequested,
      staleTime: 10 * 60 * 1000,
      cacheTime: 30 * 60 * 1000,
    }
  );

  const handleAnalyze = useCallback(() => {
    setAnalysisRequested(true);
    queryClient.invalidateQueries(analysisCacheKey);
  }, [analysisCacheKey, queryClient]);

  const handleRegenerate = useCallback(() => {
    queryClient.invalidateQueries(analysisCacheKey);
  }, [analysisCacheKey, queryClient]);

  const analysisAge = useMemo(() => {
    if (!analysisData?.generated_at) return '';
    try {
      return formatDistanceToNow(parseISO(analysisData.generated_at), { addSuffix: true });
    } catch {
      return '';
    }
  }, [analysisData]);

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ pb: '16px !important' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 1, flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>Pipeline Flow</Typography>
            {historyLoading && <CircularProgress size={16} />}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {availableOwners.length >= 2 && (
              <FormControl size="small">
                <Select
                  value={focusOwnerId}
                  onChange={(e) => setFocusOwnerId(e.target.value as string)}
                  sx={{
                    fontSize: '0.75rem',
                    height: 32,
                    '& .MuiSelect-select': { py: 0.5, pr: '24px !important', pl: 1.25 },
                  }}
                >
                  <MenuItem value="all" sx={{ fontSize: '0.8rem' }}>
                    Focus: All ({availableOwners.length})
                  </MenuItem>
                  {availableOwners.map((o) => (
                    <MenuItem key={o.id} value={o.id} sx={{ fontSize: '0.8rem' }}>
                      Focus: {o.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
            <LookbackRangeSelector value={lookback} onChange={setLookback} />
          </Box>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {funnel.map((layer, idx) => {
            const widthPct = Math.max((layer.count / maxCount) * 100, 20);
            const isExpanded = expandedStage === layer.stage;
            const color = getStageHexColor(layer.stage);
            const progressingCount = layer.advancedIn.length + layer.advancedOut.length;
            const setbackCount = layer.retreatedIn.length + layer.retreatedOut.length;
            const wonCount = layer.wonOut.length;
            const lostCount = layer.lostOut.length;
            const hasActivity = progressingCount + setbackCount + wonCount + lostCount > 0;
            const net = progressingCount + wonCount - setbackCount - lostCount;

            const progressingRows = isExpanded ? buildProgressingRows(layer) : [];
            const setbackRows = isExpanded ? buildSetbackRows(layer) : [];
            const winRows = isExpanded ? buildWinRows(layer) : [];
            const lossRows = isExpanded ? buildLossRows(layer) : [];
            const oppsInStage = isExpanded ? filteredOpps.filter((o) => o.StageName === layer.stage) : [];
            const now = new Date();
            const isStagnant = (opp: Opportunity) => {
              const lastMod = opp.LastModifiedDate || opp.CreatedDate;
              if (!lastMod) return false;
              try {
                return differenceInDays(now, parseISO(lastMod)) > 30;
              } catch {
                return false;
              }
            };

            return (
              <Box key={layer.stage}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    '&:hover': { bgcolor: 'action.hover' },
                    borderRadius: 1,
                    py: 0.75,
                    px: 1,
                  }}
                  onClick={() => setExpandedStage(isExpanded ? null : layer.stage)}
                >
                  <Box sx={{ width: '45%', pr: 2 }}>
                    <Box
                      sx={{
                        width: `${widthPct}%`,
                        minWidth: 80,
                        height: 32,
                        bgcolor: color,
                        borderRadius: '4px 16px 16px 4px',
                        display: 'flex',
                        alignItems: 'center',
                        px: 1.5,
                        transition: 'width 0.3s ease',
                        boxShadow: `0 1px 3px ${color}40`,
                      }}
                    >
                      <Typography
                        variant="caption"
                        noWrap
                        sx={{ color: '#fff', fontWeight: 600, fontSize: '0.72rem' }}
                      >
                        {layer.stage}
                      </Typography>
                    </Box>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, justifyContent: 'flex-end' }}>
                    <Tooltip title={`${layer.count} opportunities currently in ${layer.stage}`} arrow>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'right', cursor: 'default' }}>
                        {layer.count} opps
                      </Typography>
                    </Tooltip>

                    <Tooltip title={`Sum of Amount for all ${layer.count} opps in ${layer.stage}`} arrow>
                      <Typography variant="caption" sx={{ fontWeight: 700, textAlign: 'right', cursor: 'default' }}>
                        {formatDollarMillions(layer.totalAmount)}
                      </Typography>
                    </Tooltip>

                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, borderLeft: '1px solid', borderColor: 'divider', pl: 1, ml: 0.5 }}>
                      {progressingCount > 0 && (
                        <Tooltip title={`${progressingCount} opps advanced forward or entered from an earlier stage ${rangeLabel}`} arrow>
                          <Typography variant="caption" sx={{ color: '#2e7d32', fontWeight: 600, fontSize: '0.7rem', whiteSpace: 'nowrap', cursor: 'default' }}>
                            {progressingCount} progressing
                          </Typography>
                        </Tooltip>
                      )}
                      {progressingCount > 0 && wonCount > 0 && (
                        <Typography variant="caption" sx={{ color: 'text.disabled' }}>·</Typography>
                      )}
                      {wonCount > 0 && (
                        <Tooltip title={`${wonCount} opp${wonCount !== 1 ? 's' : ''} closed as Won from ${layer.stage} ${rangeLabel}`} arrow>
                          <Typography variant="caption" sx={{ color: '#1b5e20', fontWeight: 700, fontSize: '0.7rem', whiteSpace: 'nowrap', cursor: 'default' }}>
                            {wonCount} won
                          </Typography>
                        </Tooltip>
                      )}
                      {(progressingCount > 0 || wonCount > 0) && setbackCount > 0 && (
                        <Typography variant="caption" sx={{ color: 'text.disabled' }}>·</Typography>
                      )}
                      {setbackCount > 0 && (
                        <Tooltip title={`${setbackCount} opps regressed backward or fell back to an earlier stage ${rangeLabel}`} arrow>
                          <Typography variant="caption" sx={{ color: '#d32f2f', fontWeight: 600, fontSize: '0.7rem', whiteSpace: 'nowrap', cursor: 'default' }}>
                            {setbackCount} setback{setbackCount !== 1 ? 's' : ''}
                          </Typography>
                        </Tooltip>
                      )}
                      {(progressingCount > 0 || wonCount > 0 || setbackCount > 0) && lostCount > 0 && (
                        <Typography variant="caption" sx={{ color: 'text.disabled' }}>·</Typography>
                      )}
                      {lostCount > 0 && (
                        <Tooltip title={`${lostCount} opp${lostCount !== 1 ? 's' : ''} closed as Lost or Withdrawn from ${layer.stage} ${rangeLabel}`} arrow>
                          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.7rem', whiteSpace: 'nowrap', cursor: 'default' }}>
                            {lostCount} lost
                          </Typography>
                        </Tooltip>
                      )}
                      {hasActivity && (
                        <Tooltip title={`Net = (${progressingCount} progressing + ${wonCount} won) − (${setbackCount} setbacks + ${lostCount} lost)`} arrow>
                          <Box
                            sx={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              minWidth: 24,
                              px: 0.75,
                              py: 0.25,
                              ml: 0.5,
                              borderRadius: '10px',
                              bgcolor: net > 0 ? '#e8f5e9' : net < 0 ? '#ffebee' : 'grey.100',
                              cursor: 'default',
                            }}
                          >
                            <Typography
                              variant="caption"
                              sx={{
                                fontWeight: 700,
                                fontSize: '0.68rem',
                                lineHeight: 1,
                                color: net > 0 ? '#2e7d32' : net < 0 ? '#c62828' : 'text.secondary',
                              }}
                            >
                              {net > 0 ? `+${net}` : `${net}`}
                            </Typography>
                          </Box>
                        </Tooltip>
                      )}
                      {!hasActivity && layer.stagnation > 0 && (
                        <Tooltip title={`${layer.count} opps with no stage movement ${rangeLabel}`} arrow>
                          <StagnantIcon sx={{ fontSize: 15, color: '#ed6c02' }} />
                        </Tooltip>
                      )}
                    </Box>

                    <IconButton size="small" sx={{ p: 0, ml: 0.5 }}>
                      {isExpanded ? <ExpandLessIcon sx={{ fontSize: 18 }} /> : <ExpandMoreIcon sx={{ fontSize: 18 }} />}
                    </IconButton>
                  </Box>
                </Box>

                <Collapse in={isExpanded}>
                  <Box sx={{ mx: 2, mb: 1.5, p: 1.5, bgcolor: 'grey.50', borderRadius: 1, border: '1px solid', borderColor: 'grey.200' }}>
                    {progressingRows.length > 0 && (
                      <Box>
                        <Typography variant="caption" sx={{ fontWeight: 700, color: '#2e7d32' }}>
                          Progressing ({progressingRows.length})
                        </Typography>
                        <FlowTable rows={progressingRows} />
                      </Box>
                    )}

                    {winRows.length > 0 && (
                      <Box sx={{ mt: progressingRows.length > 0 ? 1.5 : 0 }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, color: '#1b5e20' }}>
                          Wins ({winRows.length})
                        </Typography>
                        <FlowTable rows={winRows} />
                      </Box>
                    )}

                    {setbackRows.length > 0 && (
                      <Box sx={{ mt: progressingRows.length > 0 || winRows.length > 0 ? 1.5 : 0 }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, color: '#d32f2f' }}>
                          Setbacks ({setbackRows.length})
                        </Typography>
                        <FlowTable rows={setbackRows} />
                      </Box>
                    )}

                    {lossRows.length > 0 && (
                      <Box sx={{ mt: progressingRows.length > 0 || winRows.length > 0 || setbackRows.length > 0 ? 1.5 : 0 }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                          Lost / Withdrawn ({lossRows.length})
                        </Typography>
                        <FlowTable rows={lossRows} />
                      </Box>
                    )}

                    {oppsInStage.length > 0 && (
                      <Box sx={{ mt: progressingRows.length > 0 || winRows.length > 0 || setbackRows.length > 0 || lossRows.length > 0 ? 1.5 : 0 }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                          In this stage ({oppsInStage.length})
                        </Typography>
                        <TableContainer component={Paper} variant="outlined" sx={{ mt: 0.5 }}>
                          <Table size="small" sx={{ tableLayout: 'fixed' }}>
                            <colgroup>
                              <col style={{ width: '50%' }} />
                              <col style={{ width: '25%' }} />
                              <col style={{ width: '20%' }} />
                              <col style={{ width: '5%' }} />
                            </colgroup>
                            <TableHead>
                              <TableRow>
                                <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }}>Opportunity</TableCell>
                                <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }}>Owner</TableCell>
                                <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }} align="right">Amount</TableCell>
                                <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }} />
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {oppsInStage.map((opp) => (
                                <TableRow key={opp.Id}>
                                  <TableCell sx={{ fontSize: '0.7rem', py: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {opp.Name}
                                  </TableCell>
                                  <TableCell sx={{ fontSize: '0.7rem', py: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'text.secondary' }}>
                                    {opp.Owner?.Name || '—'}
                                  </TableCell>
                                  <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }} align="right">
                                    {formatDollarMillions(opp.Amount || 0)}
                                  </TableCell>
                                  <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }}>
                                    {isStagnant(opp) && (
                                      <Tooltip title="No activity in 30+ days" arrow>
                                        <StagnantIcon sx={{ fontSize: 14, color: '#ed6c02' }} />
                                      </Tooltip>
                                    )}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      </Box>
                    )}

                    {!hasActivity && oppsInStage.length > 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        No stage movements {rangeLabel}.
                      </Typography>
                    )}
                    {!hasActivity && oppsInStage.length === 0 && (
                      <Typography variant="caption" color="text.secondary">
                        No stage movements {rangeLabel}.
                      </Typography>
                    )}
                  </Box>
                </Collapse>
              </Box>
            );
          })}
        </Box>

        {/* Closed section — terminal stages (wins + losses) rendered as compact
            horizontal cards below the active funnel. These opps have exited
            the active pipeline but are relevant to Progress-page reporting:
            Collecting / In Effect (signed, payment in progress) through
            Closed / Completed, and the three loss outcomes. */}
        <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography
            variant="caption"
            sx={{
              fontWeight: 700,
              color: 'text.secondary',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontSize: '0.68rem',
              display: 'block',
              mb: 1,
            }}
          >
            Closed
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {CLOSED_FUNNEL_STAGES.map((stage) => {
              const entry = closedStageTotals.get(stage) || { count: 0, total: 0 };
              const color = getStageHexColor(stage);
              return (
                <Box
                  key={stage}
                  sx={{
                    flex: '1 1 0',
                    minWidth: 140,
                    p: 1,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'grey.200',
                    bgcolor: 'grey.50',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.25,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        bgcolor: color,
                        flexShrink: 0,
                      }}
                    />
                    <Typography
                      variant="caption"
                      noWrap
                      sx={{
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        color: 'text.primary',
                        lineHeight: 1.2,
                      }}
                    >
                      {stage}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', pl: 1.75 }}>
                    <Tooltip title={`${entry.count} opportunit${entry.count === 1 ? 'y' : 'ies'} currently in ${stage}`} arrow>
                      <Typography variant="caption" sx={{ fontSize: '0.7rem', color: 'text.secondary', cursor: 'default' }}>
                        {entry.count} opp{entry.count !== 1 ? 's' : ''}
                      </Typography>
                    </Tooltip>
                    <Tooltip title={`Sum of Amount for ${entry.count} opp${entry.count !== 1 ? 's' : ''} in ${stage}`} arrow>
                      <Typography variant="caption" sx={{ fontSize: '0.7rem', fontWeight: 700, cursor: 'default' }}>
                        {formatDollarMillions(entry.total)}
                      </Typography>
                    </Tooltip>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>

        <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          {!analysisData && !analysisLoading && (
            <Button
              variant="outlined"
              size="small"
              startIcon={<AnalyzeIcon />}
              onClick={handleAnalyze}
              sx={{ textTransform: 'none', fontSize: '0.8rem' }}
            >
              Analyze Pipeline
            </Button>
          )}

          {(analysisLoading || analysisFetching) && !analysisData && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">
                Analyzing {history.length} stage changes...
              </Typography>
            </Box>
          )}

          {analysisData && (
            <Box sx={{ bgcolor: 'grey.50', borderRadius: 1, border: '1px solid', borderColor: 'grey.200', p: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <AnalyzeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'primary.main' }}>
                    AI Analysis
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {analysisFetching && <CircularProgress size={12} />}
                  <Typography variant="caption" color="text.secondary">
                    Generated {analysisAge}
                  </Typography>
                  <Link
                    component="button"
                    variant="caption"
                    onClick={handleRegenerate}
                    sx={{ fontSize: '0.7rem', cursor: 'pointer' }}
                  >
                    Regenerate
                  </Link>
                </Box>
              </Box>
              <Typography
                variant="body2"
                sx={{ whiteSpace: 'pre-line', lineHeight: 1.6, color: 'text.primary', fontSize: '0.82rem' }}
              >
                {analysisData.analysis}
              </Typography>
            </Box>
          )}
        </Box>
      </CardContent>
    </Card>
  );
};

function FlowTable({ rows }: { rows: FlowRow[] }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ mt: 0.5 }}>
      <Table size="small" sx={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: '40%' }} />
          <col style={{ width: '30%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
        </colgroup>
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }}>Opportunity</TableCell>
            <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }}>Direction</TableCell>
            <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }}>Date</TableCell>
            <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }} align="right">Amount</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.opportunityId}-${r.label}-${r.stage}`}>
              <TableCell sx={{ fontSize: '0.7rem', py: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.opportunityName}
              </TableCell>
              <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }}>
                {r.label} {r.stage}
              </TableCell>
              <TableCell sx={{ fontSize: '0.7rem', py: 0.5, color: 'text.secondary' }}>
                {formatChangeDate(r.changedDate)}
              </TableCell>
              <TableCell sx={{ fontSize: '0.7rem', py: 0.5 }} align="right">{formatDollarMillions(r.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default PipelineFunnel;
