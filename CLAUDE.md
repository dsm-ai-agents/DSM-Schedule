# DSM Schedule — Project Guide

## What This Is
A static web application that displays the DSM 2026 program schedule to participants. Built with pure HTML/CSS/JS — no framework, no build step. Deployed automatically to Vercel on every push to `main`.

## Repository
https://github.com/dsm-ai-agents/DSM-Schedule.git

## Live URL
_(update after first Vercel deploy)_

---

## Architecture

### File Roles
| File | Purpose |
|------|---------|
| `index.html` | Single-page app: Google Sign-In screen → two-panel scheduling layout |
| `css/styles.css` | All styles. CSS custom properties for theming. No external CSS framework. |
| `js/app.js` | Orchestration: AppState, Google Sign-In flow, live clock, tab switching, init |
| `js/schedule.js` | Data: Google Sheets API v4 fetch, 2D-array parsing, session normalization, rendering |
| `js/calendar.js` | Monthly calendar grid with session day highlighting |
| `data/schedule.json` | Fallback schedule data — used when not signed in or Sheets API fails |
| `vercel.json` | Vercel static site config (`buildCommand: null`, serve from repo root) |

### Script Load Order (important)
```
js/schedule.js  →  js/calendar.js  →  js/app.js
```
`app.js` is last because it defines `AppState` and calls `init()`. The other scripts expose functions that `app.js` calls at runtime (not at parse time), so there are no circular dependency issues.

---

## Timezone Handling
- **Detection:** `Intl.DateTimeFormat().resolvedOptions().timeZone` — browser-native, zero latency
- **Stored in:** `AppState.timezone` (IANA string, e.g. `"America/New_York"`)
- **Persisted in:** `sessionStorage` (survives page refresh; cleared on tab close)
- **Changed via:** Dropdown in the app header
- **Applied via:** `new Intl.DateTimeFormat('en-US', { timeZone: AppState.timezone, ...opts })`
- **All dates stored internally as UTC `Date` objects.** Never cache timezone-adjusted values. Convert at render time only.

---

## Google OAuth + Sheets API

### Configuration (set in `js/app.js` and `js/schedule.js`)
```js
// js/app.js
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID';   // replace with real client_id

// js/schedule.js
const SHEET_ID = 'YOUR_SPREADSHEET_ID';              // ID from Sheet URL
const RANGE    = 'Sheet1!A:L';                        // adjust sheet tab name if needed
```

### Auth Flow (two steps)
1. **Sign-In** — `google.accounts.id.initialize({ client_id, callback })` → returns JWT ID token → extract name, email, picture
2. **Sheets access** — `google.accounts.oauth2.initTokenClient({ client_id, scope: 'spreadsheets.readonly' })` → returns OAuth access token → used in Sheets API requests

The `client_secret` is **never used or stored in browser code.** The `client_id` is a public identifier — safe to commit.

### Google Sheet Requirements
- Sheet must be shared with the users who will sign in (not necessarily public)
- Row 1 = column headers (exact names matter):

| Column | Example |
|--------|---------|
| `date` | `2026-03-15` |
| `time_utc` | `14:00` |
| `duration_min` | `90` |
| `topic` | `AI Agents in Production` |
| `description` | `This session covers...` |
| `bullet_1` | `Who should attend: All track leads` |
| `bullet_2` | `Key takeaway: deployment patterns` |
| `bullet_3` | `Prerequisite: Module 2` |
| `bullet_4` | _(optional)_ |
| `host` | `Jane Smith` |
| `meeting_link` | `https://zoom.us/j/...` |
| `tags` | `agents,deployment` |

---

## Development

**Never open `index.html` via `file://`** — `fetch()` calls will fail due to CORS.

Always use a local HTTP server:
```bash
npx serve .
# or
python -m http.server 8080
```
Then open `http://localhost:3000` (or port shown by serve).

---

## Deployment
Auto-deploys to Vercel on every push to `main`.

**First-time setup:**
1. Go to [vercel.com](https://vercel.com) → Import Project → select `dsm-ai-agents/DSM-Schedule`
2. Vercel detects static site from `vercel.json` — no build settings needed
3. Deploy → get live URL → update the "Live URL" section at top of this file

**Also required in Google Cloud Console:**
- Add the Vercel domain to "Authorized JavaScript origins" in your OAuth client settings
- Add it to "Authorized redirect URIs" if using redirect flow

---

## Key Design Decisions
- **No framework:** Zero dependencies, instant load, no build toolchain
- **CSS Grid for layout:** `360px 1fr` — fixed sidebar, fluid content, independent scroll
- **UTC internally, Intl at display time:** Eliminates all timezone conversion bugs
- **sessionStorage (not localStorage):** Login auto-expires on tab close; no stale sessions
- **`en-CA` locale for YYYY-MM-DD:** Reliable ISO date strings from `Intl.DateTimeFormat` without manual padding
- **Fallback JSON:** App never shows a blank state even if Sheets API is unavailable

---

## Stage 2 Roadmap
- Add email-based RSVP / registration per session
- Admin panel for schedule management (write access via Sheets API)
- Domain-restricted login (check `hd` claim in Google JWT)
- Session recordings / resource links
- Email reminders (via a serverless function on Vercel)
