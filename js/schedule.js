/**
 * schedule.js — DSM 2026 Schedule
 *
 * Handles all data concerns:
 *   - Fetching from Google Sheets API v4
 *   - Fallback to local data/schedule.json
 *   - Normalizing raw rows to session objects (UTC Date internally)
 *   - Rendering session lists and detail view
 *
 * Depends on: AppState (defined in app.js, available at call time)
 */

'use strict';

/* ── Configuration ────────────────────────────────────────────
   Replace SHEET_ID with your actual Google Spreadsheet ID.
   Found in the Sheet URL: .../spreadsheets/d/SHEET_ID/edit
   RANGE should cover all data columns (A through L).
──────────────────────────────────────────────────────────── */
const SHEET_ID = '1CCk6c6cWwquCp7fEIqFXPkpRiyo_L4VkzREy0J1jD5o';
const SHEET_RANGE = 'Event Calendar!A:J';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const FALLBACK_URL = 'data/schedule.json';

/* ── Fetch from Google Sheets API v4 ─────────────────────────
   Requires an OAuth access token obtained via Google Identity
   Services Token Client (provided by app.js after sign-in).
──────────────────────────────────────────────────────────── */
async function fetchFromSheets(accessToken) {
  const url = `${SHEETS_API_BASE}/${SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}?access_token=${accessToken}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Sheets API error: HTTP ${response.status}`);
  }

  const json = await response.json();

  if (!json.values || json.values.length < 2) {
    throw new Error('Sheet is empty or has no data rows');
  }

  // values[0] = header row, values[1..] = data rows
  const [headers, ...rows] = json.values;
  return rows.map(row => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header.trim()] = (row[i] || '').trim();
    });
    return obj;
  });
}

/* ── Fetch fallback from local JSON ──────────────────────────
   Used when not signed in or when the Sheets API request fails.
──────────────────────────────────────────────────────────── */
async function fetchFallback() {
  const response = await fetch(FALLBACK_URL);
  if (!response.ok) {
    throw new Error(`Fallback fetch failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.sessions || [];
}

/* ── Normalize a raw row object to a session ─────────────────
   All dates are stored as UTC Date objects internally.
   Never store timezone-adjusted values — convert at render time.
──────────────────────────────────────────────────────────── */
function normalizeSession(raw) {
  // Parse date + time_utc into a UTC Date object
  const dateStr = (raw.date || '').trim();
  const timeStr = (raw.time_utc || '00:00').trim();
  const durationMin = parseInt(raw.duration_min || '60', 10);

  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);

  if (!year || isNaN(month) || isNaN(day)) {
    return null; // skip malformed rows
  }

  const startUTC = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0));
  const endUTC = new Date(startUTC.getTime() + durationMin * 60 * 1000);

  const bullets = [
    raw.bullet_1,
    raw.bullet_2,
    raw.bullet_3,
    raw.bullet_4,
  ].filter(b => b && b.trim());

  const tags = raw.tags
    ? raw.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  return {
    id: `${dateStr}-${timeStr.replace(':', '')}`,
    startUTC,
    endUTC,
    durationMin,
    topic: raw.topic || 'Untitled Session',
    description: raw.description || '',
    bullets,
    host: raw.host || '',
    meetingLink: raw.meeting_link || '',
    tags,
  };
}

/* ── Main load function ───────────────────────────────────────
   Called by app.js after sign-in. Returns sorted session array.
   Falls back to local JSON if accessToken is null or fetch fails.
──────────────────────────────────────────────────────────── */
async function loadSchedule(accessToken) {
  let rawRows;

  if (accessToken && SHEET_ID !== 'YOUR_SPREADSHEET_ID') {
    try {
      rawRows = await fetchFromSheets(accessToken);
    } catch (err) {
      console.warn('[schedule] Sheets API failed, using fallback:', err.message);
      rawRows = await fetchFallback();
    }
  } else {
    // No token yet, or placeholder ID — use fallback data
    if (SHEET_ID === 'YOUR_SPREADSHEET_ID') {
      console.info('[schedule] SHEET_ID not configured — using fallback data');
    }
    rawRows = await fetchFallback();
  }

  const sessions = rawRows
    .map(normalizeSession)
    .filter(Boolean) // remove nulls from malformed rows
    .sort((a, b) => a.startUTC - b.startUTC);

  return sessions;
}

/* ── Query helpers ────────────────────────────────────────────
   These read AppState.schedule which is set after loadSchedule().
──────────────────────────────────────────────────────────── */

function getUpcomingSessions(schedule) {
  const now = new Date();
  return schedule.filter(s => s.endUTC > now);
}

function getArchivedSessions(schedule) {
  const now = new Date();
  return schedule.filter(s => s.endUTC <= now);
}

function findNextSession(schedule) {
  const now = new Date();
  // First session that hasn't ended yet
  const next = schedule.find(s => s.endUTC > now);
  // Fall back to last session if all are in the past
  return next || schedule[schedule.length - 1] || null;
}

function getSessionStatus(session) {
  const now = new Date();
  if (now >= session.startUTC && now <= session.endUTC) return 'live';
  if (now < session.startUTC) return 'upcoming';
  return 'past';
}

/* ── Rendering: session detail (right panel) ─────────────────
   Uses AppState.timezone for all time formatting.
──────────────────────────────────────────────────────────── */
function renderSessionDetail(session) {
  const loadingEl  = document.getElementById('session-loading');
  const contentEl  = document.getElementById('session-content');
  const emptyEl    = document.getElementById('session-empty');

  if (!session) {
    loadingEl.style.display = 'none';
    contentEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  const tz = AppState.timezone;
  const status = getSessionStatus(session);

  // Status badge
  const badge = document.getElementById('session-status-badge');
  badge.textContent = status === 'live' ? '● Live Now' : status === 'upcoming' ? 'Upcoming' : 'Past';
  badge.className = `status-badge ${status}`;

  // Tags
  const tagsEl = document.getElementById('session-tags');
  tagsEl.innerHTML = session.tags.map(t => `<span class="tag-pill">${t}</span>`).join('');

  // Topic + description
  document.getElementById('session-topic').textContent = session.topic;
  document.getElementById('session-description').textContent = session.description;

  // Bullets
  const bulletsList = document.getElementById('session-bullets');
  bulletsList.innerHTML = session.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('');

  // Info grid
  document.getElementById('info-date').textContent = formatInTZ(session.startUTC, tz, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  document.getElementById('info-time').textContent = formatInTZ(session.startUTC, tz, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  document.getElementById('info-duration').textContent = `${session.durationMin} minutes`;
  document.getElementById('info-host').textContent = session.host || '—';

  // Join button
  const ctaEl = document.getElementById('session-cta');
  const linkEl = document.getElementById('meeting-link');
  if (session.meetingLink && session.meetingLink !== '' && !session.meetingLink.includes('placeholder')) {
    linkEl.href = session.meetingLink;
    ctaEl.classList.remove('hidden');
  } else {
    ctaEl.classList.add('hidden');
  }

  // Show content
  loadingEl.style.display = 'none';
  contentEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  // Update current session in state
  AppState.currentSession = session;

  // Highlight in list
  document.querySelectorAll('.session-list-item').forEach(el => {
    el.classList.toggle('active-item', el.dataset.id === session.id);
  });
}

/* ── Rendering: upcoming sessions list (left panel) ──────────── */
function renderUpcomingList() {
  const listEl = document.getElementById('upcoming-list');
  const emptyEl = document.getElementById('upcoming-empty');
  const tz = AppState.timezone;
  const upcoming = getUpcomingSessions(AppState.schedule);

  if (upcoming.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = upcoming.map(s => buildSessionListItem(s, tz, false)).join('');
  attachListItemListeners(listEl);
}

/* ── Rendering: archived sessions list (left panel) ─────────── */
function renderArchiveList() {
  const listEl = document.getElementById('archive-list');
  const emptyEl = document.getElementById('archive-empty');
  const tz = AppState.timezone;
  const archived = getArchivedSessions(AppState.schedule);

  if (archived.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }

  emptyEl.style.display = 'none';
  // Show newest first in archive
  const reversed = [...archived].reverse();
  listEl.innerHTML = reversed.map(s => buildSessionListItem(s, tz, true)).join('');
  attachListItemListeners(listEl);
}

/* ── List item HTML builder ───────────────────────────────────── */
function buildSessionListItem(session, tz, isPast) {
  const dateStr = formatInTZ(session.startUTC, tz, { month: 'short', day: 'numeric' });
  const timeStr = formatInTZ(session.startUTC, tz, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const pastClass = isPast ? ' past' : '';
  const isActive = AppState.currentSession && AppState.currentSession.id === session.id ? ' active-item' : '';

  return `
    <li class="session-list-item${pastClass}${isActive}" data-id="${escapeAttr(session.id)}">
      <span class="sl-date">${escapeHtml(dateStr)}</span>
      <span class="sl-time">${escapeHtml(timeStr)}</span>
      <span class="sl-topic" title="${escapeAttr(session.topic)}">${escapeHtml(session.topic)}</span>
    </li>
  `.trim();
}

/* ── Click listeners for session list items ──────────────────── */
function attachListItemListeners(listEl) {
  listEl.querySelectorAll('.session-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const session = AppState.schedule.find(s => s.id === item.dataset.id);
      if (session) renderSessionDetail(session);
    });
  });
}

/* ── Utility: safe HTML escaping ─────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}
