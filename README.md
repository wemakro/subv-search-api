# Sub-V Search API v2

Discovers and hydrates Chapter 11 Subchapter V bankruptcy cases from CourtListener.

## Setup

```bash
npm install
cp .env.example .env
# Add your COURTLISTENER_TOKEN to .env
npm start
```

## .env format

```
COURTLISTENER_TOKEN=your_token_here
PORT=3000
```

## Test CourtListener connection

```bash
npm run test:cl
```

## curl examples

```bash
# Health check
curl http://localhost:3000/health

# Check token
curl http://localhost:3000/debug/courtlistener/token

# Search Sub-V cases (discovery only)
curl "http://localhost:3000/search?dateFrom=2026-05-01&dateTo=2026-06-01&court=txsb&maxPages=3"

# Search + hydrate (slower, returns full case data)
curl "http://localhost:3000/search?dateFrom=2026-05-01&dateTo=2026-06-01&court=all&maxPages=3&hydrate=true"

# List all discovered cases
curl http://localhost:3000/cases

# Hydrate a specific docket by ID
curl -X POST http://localhost:3000/cases/123456/hydrate

# Run background discovery job
curl -X POST http://localhost:3000/jobs/discover-subv \
  -H "Content-Type: application/json" \
  -d '{"dateFrom":"2026-05-01","dateTo":"2026-06-01","court":"all","maxPages":5}'
```

## Architecture

| File | Purpose |
|---|---|
| `src/server.js` | Express app entry point |
| `src/routes.js` | All HTTP route handlers |
| `src/courtListenerClient.js` | Authenticated HTTP client with retry/backoff |
| `src/courtListenerSearchService.js` | Multi-template Sub-V discovery |
| `src/caseHydrationService.js` | Full case enrichment from 5 endpoints |
| `src/subchapterVClassifier.js` | Confidence-scored Sub-V classification |
| `src/store.js` | In-memory case store (replace with DB later) |
| `src/logger.js` | Timestamped console logger |

## CourtListener endpoints used

| Endpoint | Data |
|---|---|
| `/api/rest/v4/search/` | Case discovery |
| `/api/rest/v4/dockets/{id}/` | Case details |
| `/api/rest/v4/bankruptcy-information/?docket={id}` | Chapter, Sub-V flag |
| `/api/rest/v4/parties/?docket={id}` | Debtor, trustee, creditors |
| `/api/rest/v4/attorneys/?docket={id}` | Counsel names, firms, contact |
| `/api/rest/v4/docket-entries/?docket={id}` | Filed documents |
