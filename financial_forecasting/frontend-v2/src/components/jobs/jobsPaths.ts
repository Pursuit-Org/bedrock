// Jobs detail-page routes. Plain module (no React) so non-component code and
// `npm run test` can import it; jobsEntity.tsx re-exports these.
export const jobsOpportunityPath = (id: string) => `/jobs/opportunities/${id}`;
export const jobsContactPath = (id: number) => `/jobs/contacts/${id}`;
export const jobsAccountPath = (key: string) => `/jobs/accounts/${encodeURIComponent(key)}`;
