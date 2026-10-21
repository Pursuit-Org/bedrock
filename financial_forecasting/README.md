# Financial Forecasting Solution for Pursuit

A comprehensive financial forecasting system that bridges the gap between Salesforce (sales pipeline) and Sage Intacct (accounting/finance), providing real-time visibility into grant opportunities, payment forecasting, and cash flow projections.

## 🎯 Problem Statement

**Challenge:**
- Development/fundraising team tracks grant opportunities in Salesforce
- Finance team has no insight into when payments will arrive
- Sales team doesn't know when payments hit or invoicing status  
- Salesforce UI is complex and difficult to use for quick updates
- No visibility into cash flow projections based on pipeline probability

**Solution:**
This POC provides a simplified dashboard where:
- ✅ Development team can easily edit Salesforce opportunities (better UX than Salesforce)
- ✅ Finance team can see when payments are expected based on close dates and probability
- ✅ Automated forecasting combines sales pipeline with payment timing
- ✅ Finance can initiate invoicing workflows based on Salesforce milestone completion
- ✅ Real-time sync between Salesforce and Sage Intacct

## 📊 Current Data (Your Pursuit Org)

**Connected Salesforce Org:** joinpursuit.my.salesforce.com

> **Note (2026-04-16):** The pipeline snapshot below is POC-era sample data from Nov 2025. The live Pursuit SF org has ~6,000+ Opportunities across **22 distinct stages** (13 declared in the enum; 9 drift stages documented in `../tasks/stage-schema-drift.md`). Current live queries + funnel classifier work on real data — see `frontend/src/pages/Progress.tsx` and `routes/ai.py`.

**Pipeline Overview (POC snapshot, Nov 2025):**
- **50 grant opportunities** in pipeline
- **$35.4M total pipeline value**
- **$814K weighted expected revenue** (probability-adjusted)
- **Major funders:** Google, Amazon, PNC, Apollo, Pivotal Ventures, and more

**Sample Opportunities (POC, Nov 2025):**
- Google SMB Expansion - $300K (28% probability)
- Apollo Opportunity Foundation - $1M (5% probability)
- Black Family Philanthropies Campaign - $4M
- PNC Financial - $100K (17% probability)

## 🏗️ Architecture

```
┌─────────────────┐
│   React Frontend │  ← Simple UI for editing opportunities
│   (Port 3000)    │     and viewing forecasts
└────────┬─────────┘
         │
         ↓
┌─────────────────┐
│  FastAPI Backend │  ← Business logic, forecasting engine,
│   (Port 8000)    │     data synchronization
└────────┬─────────┘
         │
    ┌────┴────┐
    ↓         ↓
┌──────────┐ ┌─────────────┐
│Salesforce│ │Sage Intacct │
│   API    │ │     API     │
└──────────┘ └─────────────┘
```

## 🚀 Features

### 1. **Salesforce Integration** ✅ WORKING
- Read all grant opportunities with amounts, stages, and probabilities
- Update opportunities directly from the dashboard
- Simpler UX than Salesforce for quick edits
- Real-time sync back to Salesforce

### 2. **Payment Forecasting**
- Calculate expected payment dates based on close dates + payment terms
- Adjust probabilities based on historical data and deal stage
- Weight pipeline by probability for realistic revenue projections
- Identify at-risk opportunities

### 3. **Cash Flow Projections**
- Monthly cash flow projections for next 6-12 months
- Based on probability-weighted opportunity amounts
- Account for payment delays and collection rates
- Confidence levels for each projection

### 4. **Financial Metrics Dashboard**
- Total pipeline value
- Weighted (expected) revenue
- Win rates and average grant sizes
- Overdue invoices and at-risk opportunities
- Customer concentration risk analysis

### 5. **Invoice Automation** (Pending Sage Intacct connection)
- Automatically trigger invoice creation when grants are won
- Map Salesforce opportunities to Sage Intacct invoices
- Track payment status and sync back to Salesforce
- Alert finance team when invoices are overdue

## 🔧 Setup & Configuration

**→ See [DEV_SETUP_GUIDE.md](DEV_SETUP_GUIDE.md)** for step-by-step setup, env vars, and run instructions.

**Prerequisites:** Python 3.11+, Node.js 22.23.4 (run `nvm install && nvm use` from the repository root), Salesforce API access, Sage Intacct credentials (optional for POC).

## 📱 User Workflows

### For Development/Fundraising Team:
1. **View Pipeline:** See all opportunities in a clean dashboard
2. **Quick Edit:** Click any opportunity to update:
   - Stage (Qualifying, Proposal, Negotiation, etc.)
   - Amount
   - Probability
   - Close date
   - Next steps
3. **Track Progress:** Visual pipeline with stages and amounts
4. **Updates sync:** All changes automatically save to Salesforce

### For Finance Team:
1. **Payment Forecast:** See when money is expected to arrive
2. **Cash Flow View:** Monthly projections for planning
3. **Invoice Triggers:** Get notified when grants close to initiate invoicing
4. **Payment Tracking:** See which invoices are paid/pending
5. **Risk Alerts:** Identify overdue payments and at-risk opportunities

## 🎨 Dashboard Features

### Main Dashboard
- **Pipeline Overview:** Total value, weighted value, number of opportunities
- **Cash Flow Chart:** 6-month projection of expected receipts
- **Top Opportunities:** Sorted by expected value (amount × probability)
- **Recent Activity:** Latest updates and stage changes
- **Risk Indicators:** At-risk opportunities, overdue items

### Opportunities Page
- **Interactive Grid:** Sortable, filterable list of all opportunities
- **Quick Edit:** Click to edit any field inline
- **Stage Pipeline:** Visual representation of pipeline stages
- **Bulk Actions:** Update multiple opportunities at once
- **Export:** Download to Excel/CSV

### Cash Flow Page
- **Monthly Projections:** Expected receipts by month
- **Scenario Analysis:** Optimistic, realistic, pessimistic views
- **Payment Timeline:** When each opportunity is expected to pay
- **Historical Comparison:** Actual vs. projected

### Invoices Page (When Intacct connected)
- **Invoice Status:** All invoices with payment status
- **Create Invoice:** Generate invoice from won opportunity
- **Payment Tracking:** See which payments have been received
- **Aging Report:** Overdue invoices and collection priorities

## 🔮 Forecasting Logic

### Payment Date Calculation
```python
expected_payment_date = close_date + payment_terms_days + average_delay
```

### Probability Adjustment
```python
adjusted_probability = (
    stated_probability * 0.7 +
    stage_based_probability * 0.3
) * historical_account_win_rate * deal_size_factor
```

### Risk Factors
- Overdue close dates
- Early stage with near-term close
- Large deal amounts (>$100K)
- Low historical win rate for funder
- Extended payment terms (>60 days)

### Cash Flow Confidence
```python
confidence = weighted_avg_probability * forecast_count_adjustment
```

## 📊 API Endpoints

### Salesforce
- `GET /api/salesforce/opportunities` - List opportunities
- `PUT /api/salesforce/opportunities/{id}` - Update opportunity
- `GET /api/salesforce/accounts` - List accounts

### Sage Intacct
- `GET /api/intacct/invoices` - List invoices
- `POST /api/intacct/invoices` - Create invoice
- `GET /api/intacct/payments` - List payments

### Forecasting
- `GET /api/forecasting/dashboard` - Dashboard data
- `GET /api/forecasting/payment-forecast` - Payment forecasts
- `GET /api/forecasting/cash-flow` - Cash flow projections
- `GET /api/forecasting/metrics` - Key metrics
- `POST /api/forecasting/generate-report` - Generate report

### Sync
- `POST /api/sync/trigger` - Manual data sync

## 🔐 Security Considerations

### Current Setup (POC)
- ✅ Salesforce credentials stored in config file
- ⚠️ No authentication on API endpoints (for POC only)
- ⚠️ Credentials visible in config.py

### Production Recommendations
1. **Environment Variables:** Move credentials to `.env` file
2. **API Authentication:** Add JWT tokens or OAuth
3. **User Roles:** Implement role-based access control
4. **Audit Logging:** Track all data changes
5. **HTTPS:** Use SSL certificates for all API calls
6. **IP Whitelisting:** Restrict API access by IP
7. **Secrets Management:** Use AWS Secrets Manager or similar

## 🚧 Current Status

### ✅ Completed
- [x] Sage Intacct MCP service integration
- [x] Salesforce connection working with real data
- [x] Data models for opportunities, invoices, payments
- [x] Forecasting engine with probability adjustments
- [x] Payment forecast calculations
- [x] Cash flow projection logic
- [x] Risk factor identification
- [x] Backend API structure

### ⏳ In Progress
- [ ] React frontend dashboard
- [ ] Opportunity edit interface
- [ ] Cash flow visualization charts
- [ ] Invoice automation workflows

### 🔜 Todo
- [ ] Get Sage Intacct Sender Password
- [ ] Complete Sage Intacct integration
- [ ] Build complete frontend UI
- [ ] Add user authentication
- [ ] Deploy to production

## 📈 Next Steps

1. **Complete Frontend Dashboard:**
   - Build React components for opportunity list
   - Add inline editing capabilities
   - Create cash flow visualization charts
   - Implement real-time updates

2. **Connect Sage Intacct:**
   - Get Sender Password from admin
   - Test invoice creation
   - Implement payment tracking
   - Set up automated sync

3. **User Testing:**
   - Get feedback from development team
   - Get feedback from finance team
   - Iterate on UI/UX
   - Add requested features

4. **Production Deployment:**
   - Set up hosting (AWS/Heroku/etc.)
   - Configure environment variables
   - Add authentication and security
   - Set up monitoring and logging

## 🤝 Support

For questions or issues:
- Development team: Contact development@pursuit.org
- Finance team: Contact finance@pursuit.org
- Technical support: Contact IT team

## 📝 Notes

- This is a POC (Proof of Concept) built with real Pursuit data
- Currently using Salesforce production org: joinpursuit.my.salesforce.com
- 50 real grant opportunities tracked with $35.4M total pipeline
- Sage Intacct integration pending Sender Password
- All forecasting algorithms use best practices from financial planning

---

**Built for Pursuit Systems - Financial Forecasting & Pipeline Management**
