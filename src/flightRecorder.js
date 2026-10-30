/**
 * Local-only flight recorder (PRD 3.10: 100% on-device, zero telemetry).
 *
 * Keeps a bounded ring buffer of lifecycle milestones — session starts,
 * discovery phase timings with catalog sizes, library reloads, trash
 * enrichment, heartbeat — persisted to AsyncStorage with a debounce. When a
 * native-side kill (jetsam/watchdog) hits a large library, the NEXT launch
 * can show exactly what the app was doing right before it died: if the
 * previous session never reached a clean background/terminate transition we
 * prepend an `abnormal-exit` marker plus the tail of that session's log.
 *
 * Every entry point swallows its own errors: diagnostics must never be able
 * to break the app it diagnoses.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

const LOG_KEY = 'appFlightLog';
const SESSION_KEY = 'appFlightSession';
const MAX_EVENTS = 200;
const MAX_PREV_TAIL = 40;
const MAX_DETAIL_CHARS = 160;
const PERSIST_DEBOUNCE_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 60000;

let events = [];
let session = null;
let persistTimer = null;
let heartbeatTimer = null;
let initialized = false;

function clampDetail(detail) {
  if (detail === undefined || detail === null) return '';
  try {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (typeof text !== 'string') return '';
    return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
  } catch {
    return '';
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await AsyncStorage.setItem(LOG_KEY, JSON.stringify(events));
      if (session) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {}
  }, PERSIST_DEBOUNCE_MS);
}

/** Flush synchronously-scheduled writes on background/kill-friendly moments. */
export async function flushFlightLog() {
  try {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(events));
    if (session) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {}
}

export function flightEvent(kind, detail) {
  try {
    events.push({ t: Date.now(), k: String(kind || 'event'), d: clampDetail(detail) });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    schedulePersist();
  } catch {}
}

async function readPersistedState() {
  try {
    const [logRaw, sessionRaw] = await Promise.all([
      AsyncStorage.getItem(LOG_KEY),
      AsyncStorage.getItem(SESSION_KEY),
    ]);
    const prevEvents = logRaw ? JSON.parse(logRaw) : [];
    return {
      prevEvents: Array.isArray(prevEvents) ? prevEvents.slice(-MAX_PREV_TAIL) : [],
      prevSession: sessionRaw ? JSON.parse(sessionRaw) : null,
    };
  } catch {
    return { prevEvents: [], prevSession: null };
  }
}

function markSessionEnded() {
  if (session) {
    session.endedAt = Date.now();
    schedulePersist();
  }
}

function startSegment() {
  session = { startedAt: Date.now(), endedAt: null };
  schedulePersist();
}

let appStateSubscription = null;

export function initFlightRecorder() {
  if (initialized) return;
  initialized = true;
  (async () => {
    try {
      const { prevEvents, prevSession } = await readPersistedState();
      // An un-ended session that had been running for a while means the
      // process died without a background/terminate transition: the jetsam /
      // watchdog signature we want to catch.
      const diedUnexpectedly = prevSession
        && !prevSession.endedAt
        && Number.isFinite(prevSession.startedAt)
        && Date.now() - prevSession.startedAt > 20000;
      if (diedUnexpectedly) {
        events.push({ t: prevSession.startedAt, k: 'abnormal-exit', d: `prev-session ${Math.round((Date.now() - prevSession.startedAt) / 1000)}s` });
        prevEvents.forEach((e) => events.push(e));
      } else if (prevSession?.endedAt) {
        events.push({ t: prevSession.endedAt, k: 'prev-session-ended-clean', d: '' });
      }
      startSegment();
      flightEvent('launch', '');
      appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'background') {
          flightEvent('background', '');
          markSessionEnded();
          void flushFlightLog();
        } else if (state === 'active' && session?.endedAt) {
          startSegment();
          flightEvent('foreground', '');
        }
      });
      heartbeatTimer = setInterval(() => {
        if (session && !session.endedAt) {
          flightEvent('heartbeat', `up ${Math.round((Date.now() - session.startedAt) / 1000)}s`);
        }
      }, HEARTBEAT_INTERVAL_MS);
    } catch {}
  })();
}

/** Human-readable dump for the hidden diagnostics viewer (version row long-press). */
export async function getFlightLogText() {
  try {
    const { prevEvents } = await readPersistedState();
    const lines = [];
    const fmt = (e) => {
      const when = e?.t ? new Date(e.t).toLocaleTimeString() : '?';
      const detail = typeof e?.d === 'string' && e.d ? ` ${e.d}` : '';
      return `[${when}] ${e?.k || 'event'}${detail}`;
    };
    if (prevEvents.length) {
      lines.push('── prev ──');
      prevEvents.forEach((e) => lines.push(fmt(e)));
    }
    lines.push('── current ──');
    events.slice(-MAX_EVENTS).forEach((e) => lines.push(fmt(e)));
    return lines.join('\n');
  } catch {
    return '';
  }
}
