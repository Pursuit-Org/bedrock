/**
 * Zero-dependency stub API for previewing the Jobs > Intro requests zone.
 *
 * Node-only alternative to scripts/preview_intro_requests.py, for machines
 * without Python 3.10+. You need Node anyway to run the frontend, so this
 * makes the preview a one-toolchain job.
 *
 * The payloads below are recorded verbatim from the real
 * routes/jobs_intro.py router (that is what the Python version serves live);
 * only the timestamps are recomputed so the relative dates stay sensible.
 *
 *   MODE=after   (default) builder lookup succeeds
 *   MODE=before  builder lookup returns nothing, as public.users does for
 *                bedrock_user under RLS. On this branch the fallback chain
 *                catches it and renders "Builder #428"; on main the same
 *                empty lookup rendered a bare "from — (builder)".
 *
 * Usage, from financial_forecasting/frontend-v2, in two terminals:
 *
 *     node scripts/preview-intro-api.mjs
 *     npm run dev
 *
 * Then open http://localhost:4200/jobs
 */
import { createServer } from 'node:http';

const MODE = process.env.MODE === 'before' ? 'before' : 'after';
const PORT = 8000;

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const staffRow = {
  id: '239f08c7-4e45-4539-8c41-2302bb35de67',
  source: 'staff',
  contact_id: 1001,
  contact_name: 'Dana Whitfield',
  contact_company: 'Northwind',
  contact_title: 'Engineering Manager',
  connector_staff_id: 4,
  connector_name: 'Sam Okafor',
  connector_email: 'sam.okafor@example.org',
  builder_id: null,
  builder_cohort: null,
  requested_by: 'jordan.reyes@example.org',
  requested_by_name: 'Jordan Reyes',
  specific_ask: 'industry_advice',
  context:
    'Sample staff→staff ask. Would you be open to introducing one of our ' +
    'builders for a 20-minute coffee chat?',
  status: 'pending',
  response_note: null,
  responded_at: null,
  created_at: daysAgo(4),
};

const builderRow = {
  id: '15',
  source: 'builder',
  contact_id: 1002,
  contact_name: 'Priya Raman',
  contact_company: 'Lumen Labs',
  contact_title: 'Director of Product Engineering',
  connector_staff_id: 4,
  connector_name: null,
  connector_email: 'sam.okafor@example.org',
  builder_id: 428,
  builder_cohort: MODE === 'after' ? 'March 2026 L1+' : null,
  requested_by: MODE === 'after' ? 'alex.mensah@example.org' : 'Builder #428',
  requested_by_name: MODE === 'after' ? 'Alex Mensah' : 'Builder #428',
  specific_ask: 'industry_advice',
  context:
    'Sample builder ask. Their background bridging product strategy and ' +
    'technical architecture is exactly the path I am trying to grow into.',
  status: 'pending',
  response_note: null,
  responded_at: null,
  created_at: daysAgo(38),
};

const ME = {
  email: 'sam.okafor@example.org',
  name: 'Sam Okafor',
  sub: 'sam',
  salesforce_connected: false,
  google_connected: true,
  slack_configured: true,
};

const send = (res, body) => {
  const json = JSON.stringify(body);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
};

createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  if (path === '/auth/me') return send(res, ME);
  if (path === '/api/jobs/intro-requests') {
    return send(res, { success: true, data: [staffRow, builderRow] });
  }

  // Response shape matters: hooks destructure these differently, and handing
  // back the wrong one throws inside render (a caught .filter on an object
  // blanks the whole page). Salesforce endpoints return bare arrays; the
  // notification badge reads data.data.count; the rest use {success, data}.
  if (path.startsWith('/api/salesforce/')) return send(res, []);
  if (path === '/api/notifications/unread-count') {
    return send(res, { success: true, data: { count: 0 } });
  }
  // Every other zone renders from an empty result.
  return send(res, { success: true, data: [] });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  intro-requests preview API — MODE=${MODE}`);
  console.log(`  listening on http://127.0.0.1:${PORT}`);
  console.log('  now run "npm run dev" in another terminal, then open');
  console.log('  http://localhost:4200/jobs\n');
});
