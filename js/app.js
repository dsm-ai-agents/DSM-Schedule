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
   GOOGLE_CLIENT_ID:     OAuth 2.0 client ID — safe to commit.
   GOOGLE_CLIENT_SECRET: Loaded at runtime from js/config.js,
                         which is gitignored and auto-generated.
                         Local:  copy .env.example → .env, fill in
                                 GOOGLE_CLIENT_SECRET, then run:
                                 node generate-config.js
                         Vercel: set GOOGLE_CLIENT_SECRET in
                                 Project Settings → Environment Variables.
   REDIRECT_URIS:        Must exactly match "Authorized redirect URIs"
                         registered in Google Cloud Console for this
                         OAuth client.
──────────────────────────────────────────────────────────── */
const GOOGLE_CLIENT_ID     = '1073582681335-g4n3hl2pl6v0sb83u1hq4bm1i1kjj7o6.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = (window.APP_CONFIG && window.APP_CONFIG.googleClientSecret) || '';

const REDIRECT_URIS = [
  'http://localhost:3000',
  'https://dsm-schedule.vercel.app',   // update once your Vercel URL is confirmed
];

// Scopes: identity (openid/profile/email) + read-only Sheets access
const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
].join(' ');

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

/* ── Left panel tab switching ────────────────────────────────── */
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

/* ── Right panel tab switching ───────────────────────────────── */
function initRightTabs() {
  document.querySelectorAll('.right-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchRightTab(btn.dataset.rightTab));
  });
}

window.switchRightTab = function switchRightTab(tabName) {
  document.querySelectorAll('.right-tab-btn').forEach(b => {
    const active = b.dataset.rightTab === tabName;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active);
  });
  document.querySelectorAll('.right-tab-content').forEach(c => {
    const active = c.id === 'right-tab-' + tabName;
    c.classList.toggle('hidden', !active);
    c.classList.toggle('active', active);
  });
};

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

/* ── PKCE helpers ─────────────────────────────────────────────── */

function getCurrentRedirectUri() {
  // Always use the current page's origin — works for any deployment URL
  // without needing to enumerate every possible domain in REDIRECT_URIS.
  // Just register the actual URL in Google Cloud Console.
  return window.location.origin;
}

function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64urlEncode(array.buffer);
}

async function generateCodeChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  const hash    = await crypto.subtle.digest('SHA-256', encoded);
  return base64urlEncode(hash);
}

/* ── Google Sign-In via PKCE redirect ────────────────────────── */

async function initGoogleSignIn() {
  const btn = document.getElementById('g-signin-btn');
  if (btn) {
    btn.addEventListener('click', startSignIn);
    btn.disabled = false;
  }
}

async function startSignIn() {
  const btn = document.getElementById('g-signin-btn');
  if (btn) btn.disabled = true;

  const verifier   = generateCodeVerifier();
  const challenge  = await generateCodeChallenge(verifier);
  const state      = crypto.randomUUID();

  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('oauth_state',   state);

  const params = new URLSearchParams({
    client_id:             GOOGLE_CLIENT_ID,
    redirect_uri:          getCurrentRedirectUri(),
    response_type:         'code',
    scope:                 OAUTH_SCOPES,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state:                 state,
    access_type:           'online',
    prompt:                'select_account',
  });

  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/* ── OAuth callback handler (runs on page load if ?code= present) */

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const state  = params.get('state');
  const error  = params.get('error');

  if (error) {
    // Clean URL before showing error
    window.history.replaceState({}, '', window.location.pathname);
    showLoginError(`Sign-in failed: ${error}`);
    return false;
  }

  if (!code) return false;

  // Verify state to prevent CSRF
  const savedState = sessionStorage.getItem('oauth_state');
  if (state !== savedState) {
    window.history.replaceState({}, '', window.location.pathname);
    showLoginError('Security check failed. Please try again.');
    return false;
  }

  const verifier = sessionStorage.getItem('pkce_verifier');
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('oauth_state');

  // Clean the ?code= from the URL before any async work
  window.history.replaceState({}, '', window.location.pathname);

  // Exchange authorization code for tokens
  let tokens;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code:          code,
        code_verifier: verifier,
        grant_type:    'authorization_code',
        redirect_uri:  getCurrentRedirectUri(),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error_description || err.error || `HTTP ${res.status}`);
    }

    tokens = await res.json();
  } catch (err) {
    showLoginError(`Token exchange failed: ${err.message}`);
    console.error('[app] Token exchange error:', err);
    return false;
  }

  // Decode the ID token JWT for user profile
  try {
    const payload = parseJwt(tokens.id_token);
    AppState.user.name    = payload.name    || payload.email || 'User';
    AppState.user.email   = payload.email   || '';
    AppState.user.picture = payload.picture || '';
  } catch {
    AppState.user.name  = 'User';
    AppState.user.email = '';
  }

  AppState.accessToken = tokens.access_token;
  sessionStorage.setItem('dsm_user',  JSON.stringify(AppState.user));
  sessionStorage.setItem('dsm_token', tokens.access_token);

  return true;
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
async function init() {
  // Wire up tabs and in-app timezone switcher
  initTabs();
  initRightTabs();
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

  // Check if this is the OAuth redirect callback (URL has ?code=)
  if (window.location.search.includes('code=')) {
    const ok = await handleOAuthCallback();
    if (ok) {
      showApp(AppState.accessToken);
      return;
    }
  }

  // Wire up the sign-in button
  initGoogleSignIn();
}

// Kick off once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
