/**
 * app.js — DSM 2026 Schedule
 *
 * Orchestration layer. Owns:
 *   - AppState (single source of truth)
 *   - Google Sign-In + Sheets OAuth flow
 *   - Timezone detection and switching
 *   - Live clock
 *   - Tab switching
 *   - Application init
 *
 * Script load order: schedule.js → calendar.js → app.js
 */

'use strict';

/* ── Configuration ────────────────────────────────────────────
   Replace GOOGLE_CLIENT_ID with your actual OAuth client ID.
   The client_id is safe to commit — it is a public identifier.
   The client_secret is NEVER used or stored in browser code.
──────────────────────────────────────────────────────────── */
const GOOGLE_CLIENT_ID = '1073582681335-g4n3hl2pl6v0sb83u1hq4bm1i1kjj7o6.apps.googleusercontent.com';

// OAuth scope for reading Google Sheets
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/* ── AppState ─────────────────────────────────────────────────
   Single source of truth for runtime state.
   Exported to window so schedule.js / calendar.js can read it.
──────────────────────────────────────────────────────────── */
window.AppState = {
  user: {
    name:    '',
    email:   '',
    picture: '',
  },
  timezone:        '',   // IANA string e.g. "America/New_York"
  accessToken:     null, // Google OAuth access token for Sheets API
  schedule:        [],   // normalized session objects
  currentSession:  null, // session shown in right panel
};

/* ── Timezone utilities ───────────────────────────────────────── */

function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/* ── Cohort Timezone Groups ───────────────────────────────────
   Grouped by the five DSM participant regions.
   Each entry: { label: display string, value: IANA timezone }.
   The app auto-detects the user's timezone and pre-selects the
   matching option; if it falls outside these groups it appears
   under "Other" so no participant is ever left unmatched.
──────────────────────────────────────────────────────────── */
const TIMEZONE_GROUPS = [
  {
    group: 'Western — USA & Canada',
    zones: [
      { label: 'Pacific Time  — PST/PDT  (Los Angeles, Vancouver, Seattle)',  value: 'America/Los_Angeles' },
      { label: 'Mountain Time — MST/MDT  (Denver, Calgary, Phoenix)',          value: 'America/Denver'      },
      { label: 'Central Time  — CST/CDT  (Chicago, Dallas, Winnipeg)',         value: 'America/Chicago'     },
      { label: 'Eastern Time  — EST/EDT  (New York, Toronto, Miami)',          value: 'America/New_York'    },
      { label: 'Atlantic Time — AST/ADT  (Halifax, Nova Scotia)',              value: 'America/Halifax'     },
    ],
  },
  {
    group: 'UK',
    zones: [
      { label: 'London — GMT / BST  (UTC+0 / UTC+1 summer)', value: 'Europe/London' },
    ],
  },
  {
    group: 'Middle East',
    zones: [
      { label: 'Dubai / Abu Dhabi — GST  (UTC+4)',         value: 'Asia/Dubai'   },
      { label: 'Riyadh / Jeddah  — AST  (UTC+3)',          value: 'Asia/Riyadh'  },
      { label: 'Kuwait / Doha    — (UTC+3)',                value: 'Asia/Kuwait'  },
    ],
  },
  {
    group: 'India & Pakistan',
    zones: [
      { label: 'India    — IST  (UTC+5:30)', value: 'Asia/Kolkata' },
      { label: 'Pakistan — PKT  (UTC+5)',    value: 'Asia/Karachi' },
    ],
  },
  {
    group: 'Southeast Asia',
    zones: [
      { label: 'Singapore / Kuala Lumpur — SGT/MYT  (UTC+8)', value: 'Asia/Singapore'    },
      { label: 'Manila                   — PHT       (UTC+8)', value: 'Asia/Manila'        },
      { label: 'Bangkok / Ho Chi Minh    — ICT       (UTC+7)', value: 'Asia/Bangkok'       },
      { label: 'Jakarta                  — WIB       (UTC+7)', value: 'Asia/Jakarta'       },
    ],
  },
];

// Flat set of all curated IANA values (used for fallback matching)
const CURATED_TZ_VALUES = new Set(
  TIMEZONE_GROUPS.flatMap(g => g.zones.map(z => z.value))
);

function populateTimezoneSelect(selectId, selectedTZ) {
  const select = document.getElementById(selectId);
  if (!select) return;

  let html = '';

  TIMEZONE_GROUPS.forEach(({ group, zones }) => {
    html += `<optgroup label="${group}">`;
    zones.forEach(({ label, value }) => {
      const sel = value === selectedTZ ? ' selected' : '';
      html += `<option value="${value}"${sel}>${label}</option>`;
    });
    html += `</optgroup>`;
  });

  // If the browser-detected timezone isn't in our curated groups,
  // surface it under "Other" so the user is never silently defaulted
  // to the wrong region.
  if (selectedTZ && !CURATED_TZ_VALUES.has(selectedTZ)) {
    html += `<optgroup label="Other (detected)">`;
    html += `<option value="${selectedTZ}" selected>${selectedTZ.replace(/_/g, ' ')}</option>`;
    html += `</optgroup>`;
  }

  select.innerHTML = html;
}

// Format a Date in a given IANA timezone
window.formatInTZ = function(date, timezone, options) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      ...options,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
};

/* ── Live Clock ───────────────────────────────────────────────── */
let clockInterval = null;

function startClock() {
  if (clockInterval) clearInterval(clockInterval);

  function tick() {
    const now = new Date();
    const tz  = AppState.timezone;

    document.getElementById('live-time').textContent = formatInTZ(now, tz, {
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    document.getElementById('live-date').textContent = formatInTZ(now, tz, {
      weekday: 'long',
      month:   'long',
      day:     'numeric',
      year:    'numeric',
    });
  }

  tick(); // immediate first tick
  clockInterval = setInterval(tick, 1000);
}

/* ── Tab switching ────────────────────────────────────────────── */
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.remove('active');
        c.classList.add('hidden');
      });

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const panel = document.getElementById('tab-' + target);
      if (panel) {
        panel.classList.remove('hidden');
        panel.classList.add('active');
      }
    });
  });
}

/* ── Timezone switcher (in-app) ──────────────────────────────── */
function initTimezoneSwitcher() {
  const select = document.getElementById('tz-switcher');
  if (!select) return;

  select.addEventListener('change', () => {
    AppState.timezone = select.value;
    sessionStorage.setItem('dsm_tz', AppState.timezone);
    refreshAllTimezoneDisplays();
  });
}

function refreshAllTimezoneDisplays() {
  renderUpcomingList();
  renderArchiveList();
  if (AppState.currentSession) {
    renderSessionDetail(AppState.currentSession);
  }
  refreshCalendar();
}

/* ── Google Sign-In (Step 1: identity) ───────────────────────── */
function initGoogleSignIn() {
  // If the GIS library hasn't loaded yet, retry after a short delay
  if (typeof google === 'undefined' || !google.accounts) {
    setTimeout(initGoogleSignIn, 300);
    return;
  }

  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID') {
    // No client ID configured — skip Google Sign-In and use fallback
    console.warn('[app] GOOGLE_CLIENT_ID not configured — bypassing sign-in');
    showSignInBypass();
    return;
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback:  handleCredentialResponse,
    auto_select: false,
  });

  google.accounts.id.renderButton(
    document.getElementById('g-signin-btn'),
    {
      theme: 'filled_blue',
      size:  'large',
      width: 280,
      text:  'signin_with',
    }
  );
}

function handleCredentialResponse(response) {
  try {
    // Decode the JWT ID token (no signature verification needed client-side)
    const payload = parseJwt(response.credential);
    AppState.user.name    = payload.name    || payload.email || 'User';
    AppState.user.email   = payload.email   || '';
    AppState.user.picture = payload.picture || '';

    // Persist user info
    sessionStorage.setItem('dsm_user', JSON.stringify(AppState.user));

    // Step 2: Request Sheets API access token
    requestSheetsToken();
  } catch (err) {
    showLoginError('Sign-in failed. Please try again.');
    console.error('[app] handleCredentialResponse error:', err);
  }
}

/* ── Google OAuth Token Client (Step 2: Sheets access) ──────── */
let tokenClient = null;

function initTokenClient() {
  if (typeof google === 'undefined') return;

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     SHEETS_SCOPE,
    callback:  handleTokenResponse,
  });
}

function requestSheetsToken() {
  if (!tokenClient) {
    initTokenClient();
  }
  if (tokenClient) {
    tokenClient.requestAccessToken({ prompt: 'none' });
  } else {
    // Can't get token — proceed without Sheets API (fallback data)
    showApp(null);
  }
}

function handleTokenResponse(tokenResponse) {
  if (tokenResponse.error) {
    console.warn('[app] Token error:', tokenResponse.error, '— using fallback data');
    showApp(null);
    return;
  }
  AppState.accessToken = tokenResponse.access_token;
  sessionStorage.setItem('dsm_token', tokenResponse.access_token);
  showApp(tokenResponse.access_token);
}

/* ── Sign-out ─────────────────────────────────────────────────── */
function signOut() {
  sessionStorage.removeItem('dsm_user');
  sessionStorage.removeItem('dsm_tz');
  sessionStorage.removeItem('dsm_token');
  AppState.user = { name: '', email: '', picture: '' };
  AppState.accessToken = null;
  AppState.schedule = [];
  AppState.currentSession = null;

  if (clockInterval) {
    clearInterval(clockInterval);
    clockInterval = null;
  }

  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.disableAutoSelect();
  }

  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

/* ── Show app (transition login → main) ──────────────────────── */
async function showApp(accessToken) {
  // Detect and set timezone
  const savedTZ = sessionStorage.getItem('dsm_tz');
  AppState.timezone = savedTZ || detectTimezone();

  // Populate timezone switcher
  populateTimezoneSelect('tz-switcher', AppState.timezone);

  // Update user chip in left panel
  const nameShortEl  = document.getElementById('user-name-short');
  const avatarEl     = document.getElementById('user-avatar');
  const firstName    = AppState.user.name.split(' ')[0];
  nameShortEl.textContent = firstName;
  if (AppState.user.picture) {
    avatarEl.src = AppState.user.picture;
    avatarEl.style.display = '';
  } else {
    avatarEl.style.display = 'none';
  }

  // Show app, hide login
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Start clock immediately
  startClock();

  // Load schedule data
  try {
    AppState.schedule = await loadSchedule(accessToken);
  } catch (err) {
    console.error('[app] Failed to load schedule:', err);
    AppState.schedule = [];
  }

  // Render everything
  renderUpcomingList();
  renderArchiveList();
  renderCalendar(AppState.schedule, AppState.timezone);

  // Show the next upcoming session in right panel
  const nextSession = findNextSession(AppState.schedule);
  renderSessionDetail(nextSession);
}

/* ── Bypass sign-in when client ID not configured ─────────────── */
function showSignInBypass() {
  // Show a simplified button that bypasses auth
  const container = document.getElementById('g-signin-btn');
  container.innerHTML = `
    <button class="bypass-btn" id="bypass-signin">
      View Schedule (Demo Mode)
    </button>
  `;
  document.getElementById('bypass-signin').addEventListener('click', () => {
    AppState.user = { name: 'Demo User', email: 'demo@dsm.ai', picture: '' };
    sessionStorage.setItem('dsm_user', JSON.stringify(AppState.user));
    showApp(null);
  });
}

/* ── JWT decoder (client-side, no verification) ──────────────── */
function parseJwt(token) {
  const base64Url = token.split('.')[1];
  const base64    = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const jsonStr   = decodeURIComponent(
    atob(base64).split('').map(c =>
      '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
    ).join('')
  );
  return JSON.parse(jsonStr);
}

/* ── Error display ─────────────────────────────────────────────── */
function showLoginError(msg) {
  const el = document.getElementById('login-error');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

/* ── Init ─────────────────────────────────────────────────────── */
function init() {
  // Wire up tabs and in-app timezone switcher
  initTabs();
  initTimezoneSwitcher();

  // Sign-out button
  const signOutBtn = document.getElementById('sign-out-btn');
  if (signOutBtn) signOutBtn.addEventListener('click', signOut);

  // Check for an existing session in sessionStorage
  const savedUser  = sessionStorage.getItem('dsm_user');
  const savedTZ    = sessionStorage.getItem('dsm_tz');
  const savedToken = sessionStorage.getItem('dsm_token');

  if (savedUser) {
    try {
      AppState.user = JSON.parse(savedUser);
      AppState.timezone = savedTZ || detectTimezone();
      AppState.accessToken = savedToken || null;
      // Go straight to app — no need to re-authenticate
      showApp(AppState.accessToken);
      return;
    } catch {
      sessionStorage.clear();
    }
  }

  // First visit — pre-detect timezone for login page context
  AppState.timezone = detectTimezone();

  // Initialize Google Sign-In
  initGoogleSignIn();
}

// Kick off once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
