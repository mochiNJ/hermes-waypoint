/**
 * Waypoint — Session Status for Hermes Desktop
 * ------------------------------------------------------------------
 * "Where was I?" for people who juggle many AI sessions.
 *
 * A thin status bar sits next to every session in the sidebar. Four states only
 * (on purpose — more colours = more thinking):
 *
 *   grey    not tracked
 *   yellow  Working   — with an optional "next step" note (where you stopped)
 *   purple  Waiting   — on someone else: who/what + a follow-up reminder
 *   green   Done      — got what you came for; start fresh (with a handoff link)
 *
 * Gestures on the bar:  click = next state · right-click / Shift+click = the
 * status card (all states, notes, reminder, fresh start, archive).
 * Plus: a Status Board page (columns + follow-ups + 30-second triage of
 * untracked sessions), a status-bar counter, ⌘K commands, reminders (in-app +
 * Windows notification), English + Arabic.
 *
 * Data never leaves the machine and is never sent to the agent: plugin-scoped
 * local storage, keyed by the durable session id (survives compression).
 *
 * Contract: single plain-ESM file, imports only @hermes/plugin-sdk + react.
 */

import {
  atom,
  Button,
  COMPOSER_AREAS,
  Codicon,
  ConfirmDialog,
  host,
  Input,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ROUTES_AREA,
  SegmentedControl,
  SESSION_ROW_AREAS,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Switch,
  Tip,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

export const ID = 'waypoint' // never change: storage is namespaced by it
export const VERSION = '2.0.0'
const ROUTE = '/session-status'
const DAY = 24 * 60 * 60 * 1000
const CHECK_MS = 60 * 1000

// =====================================================================
// Pure logic (exported for unit tests — no SDK, no React)
// =====================================================================

export const STATES = ['none', 'wip', 'waiting', 'done']

export const DEFAULT_SETTINGS = {
  clickMode: 'cycle', // 'cycle' = click advances state; 'card' = click opens the card
  remindHour: 10, // reminders land at this local hour
  hideUnset: false, // grey bars only on hover
  staleDays: 7, // Working/Waiting untouched this long = "stale"
  banner: true, // "where you stopped" strip above the composer
  digest: true, // one morning summary toast per day
  labels: { wip: '', waiting: '', done: '' } // custom names ('' = default)
}

export function nextState(s) {
  return STATES[(STATES.indexOf(s) + 1 + STATES.length) % STATES.length] || 'wip'
}

export function prevState(s) {
  return STATES[Math.max(0, STATES.indexOf(s) - 1)]
}

/** Normalise whatever storage held (v1 maps, partial v2) into a v2 snapshot. */
export function normalise(raw = {}) {
  const statuses = {}
  for (const [id, s] of Object.entries(raw.statuses || {})) {
    if (s && s !== 'none' && STATES.includes(s)) statuses[id] = s
  }
  const waits = {}
  for (const [id, w] of Object.entries(raw.waits || {})) {
    if (!w || typeof w !== 'object') continue
    waits[id] = {
      who: typeof w.who === 'string' ? w.who : '',
      remindAt: Number.isFinite(w.remindAt) ? w.remindAt : null,
      notified: !!w.notified
    }
  }
  const meta = {}
  for (const [id, m] of Object.entries(raw.meta || {})) {
    if (!m || typeof m !== 'object') continue
    meta[id] = {
      setAt: Number.isFinite(m.setAt) ? m.setAt : null,
      next: typeof m.next === 'string' ? m.next : '',
      outcome: typeof m.outcome === 'string' ? m.outcome : ''
    }
  }
  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
  const settings = {
    ...DEFAULT_SETTINGS,
    ...s,
    labels: { ...DEFAULT_SETTINGS.labels, ...(s.labels || {}) }
  }
  if (!['cycle', 'card'].includes(settings.clickMode)) settings.clickMode = 'cycle'
  settings.remindHour = clampInt(settings.remindHour, 0, 23, 10)
  settings.staleDays = clampInt(settings.staleDays, 1, 90, 7)
  settings.hideUnset = !!settings.hideUnset
  settings.banner = settings.banner !== false
  settings.digest = settings.digest !== false
  const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter(x => typeof x === 'string') : []
  const digestDay = typeof raw.digestDay === 'string' ? raw.digestDay : ''
  return { statuses, waits, meta, settings, skipped, digestDay }
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/** Pure state transition: returns a new snapshot. */
export function applyStatus(snap, id, next, now = Date.now()) {
  const statuses = { ...snap.statuses }
  const waits = { ...snap.waits }
  const meta = { ...snap.meta }
  const prev = statuses[id] || 'none'
  if (next === 'none') delete statuses[id]
  else statuses[id] = next
  if (next !== 'waiting') delete waits[id]
  if (next === 'none') delete meta[id]
  else if (prev !== next) meta[id] = { next: '', outcome: '', ...(meta[id] || {}), setAt: now }
  return { ...snap, statuses, waits, meta }
}

/** Reminder time for an option ('1d' | '3d' | '7d' | 'none') at `hour` local. */
export function remindAtFor(option, now = Date.now(), hour = 10) {
  if (!option || option === 'none') return null
  const days = parseInt(option, 10)
  if (!Number.isFinite(days)) return null
  const d = new Date(now + days * DAY)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/** Ids whose reminder is due and not yet announced. */
export function dueToNotify(waits, statuses, now = Date.now()) {
  return Object.entries(waits)
    .filter(([id, w]) => statuses[id] === 'waiting' && w.remindAt && !w.notified && w.remindAt <= now)
    .map(([id]) => id)
}

export function isDue(wait, now = Date.now()) {
  return !!(wait && wait.remindAt && wait.remindAt <= now)
}

export function isStale(snap, id, now = Date.now()) {
  const s = snap.statuses[id]
  const setAt = snap.meta[id]?.setAt
  if (!(s === 'wip' || s === 'waiting') || !setAt) return false
  return now - setAt >= snap.settings.staleDays * DAY
}

export function counts(snap, now = Date.now()) {
  const c = { wip: 0, waiting: 0, done: 0, due: 0, stale: 0 }
  for (const [id, s] of Object.entries(snap.statuses)) {
    if (c[s] !== undefined) c[s]++
    if (s === 'waiting' && isDue(snap.waits[id], now)) c.due++
    if (isStale(snap, id, now)) c.stale++
  }
  return c
}

/** Local calendar day key, e.g. "2026-10-12". */
export function dayKey(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Should the once-a-day summary fire now? Only with something worth saying. */
export function digestDue(snap, now = Date.now()) {
  if (!snap.settings.digest || snap.digestDay === dayKey(now)) return false
  const c = counts(snap, now)
  return c.waiting + c.wip > 0
}

/** The draft placed in a fresh session: links the old one so the agent can pull context. */
export function handoffText({ id, profile, title, next, outcome }) {
  const parts = [`Continuing from @session:${profile || 'default'}/${id}`]
  if (title) parts[0] += ` ("${title}")`
  parts[0] += '.'
  if (outcome) parts.push(`Outcome so far: ${outcome}`)
  if (next) parts.push(`Where we left off / next step: ${next}`)
  parts.push('')
  return parts.join('\n')
}

/** Relative age, compact: "now", "5m", "3h", "4d", "2w". */
export function ago(ms, now = Date.now()) {
  if (!ms) return ''
  const s = Math.max(0, now - ms) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 7))}w`
}

/** Export/import payload (backup or move to another machine). */
export function exportPayload(snap) {
  return JSON.stringify({ app: 'waypoint-session-status', version: VERSION, ...snap }, null, 2)
}

export function importPayload(text) {
  const raw = JSON.parse(text)
  if (!raw || typeof raw !== 'object' || !raw.statuses) throw new Error('Not a Waypoint backup')
  return normalise(raw)
}

// =====================================================================
// Strings (English + Arabic)
// =====================================================================

const EN = {
  name: 'Waypoint',
  board: 'Status Board',
  state: { none: 'Not tracked', wip: 'Working', waiting: 'Waiting', done: 'Done' },
  hint: {
    none: 'Not tracked yet.',
    wip: 'You are in the middle of this.',
    waiting: 'Blocked on someone else.',
    done: 'You got what you came for. Start fresh next time.'
  },
  nextStep: 'Next step (where you stopped)',
  nextStepPh: 'e.g. render the Arabic version',
  who: 'Waiting on who / what?',
  whoPh: 'e.g. Ahmad: shipping documents',
  remindMe: 'Remind me',
  remind: { keep: 'Keep', due: 'Due now', '1d': 'Tomorrow', '3d': '3 days', '7d': '1 week', none: 'Off' },
  currentReminder: d => `Reminder: ${d}`,
  outcome: 'Outcome (optional)',
  outcomePh: 'e.g. final cut approved',
  freshStart: 'Start fresh session',
  freshStartTip: 'Opens a new session with a link back to this one, so the agent can pull the context.',
  archive: 'Archive',
  archived: 'Session archived',
  undo: 'Undo',
  save: 'Save',
  close: 'Close',
  keys: 'Enter saves · Esc closes',
  tipClickCycle: 'Click: next status · Right-click: options',
  tipClickCard: 'Click: options',
  waitingOn: who => `Waiting on: ${who}`,
  waitingSomeone: 'Waiting on someone',
  reminderAt: d => `reminder ${d}`,
  followUpNow: 'follow up now!',
  stale: d => `untouched for ${d}`,
  followUp: 'Follow up',
  followUpMsg: (who, title) => (title ? `${who} — ${title}` : who),
  openSession: 'Open session',
  remindTomorrow: 'Remind tomorrow',
  // board
  boardSub: 'Every session you are juggling, in one place.',
  dueNow: 'Follow-ups due',
  noneDue: 'No follow-ups due.',
  empty: 'Nothing here.',
  triage: 'Triage',
  triageSub: 'Recent sessions without a status. One click each.',
  triageDone: 'All recent sessions have a status.',
  skip: 'Skip',
  archiveDone: n => `Archive ${n} done`,
  archiveDoneTitle: n => `Archive ${n} done sessions?`,
  archiveDoneDesc: 'They leave the sidebar but nothing is deleted — you can find them under archived sessions.',
  untitled: 'Untitled session',
  setAgo: d => `${d} ago`,
  // statusbar
  barTip: c => `Working ${c.wip} · Waiting ${c.waiting}${c.due ? ` (${c.due} due)` : ''} · Done ${c.done}`,
  // palette
  cmdBoard: 'Waypoint: open Status Board',
  cmdMark: s => `Waypoint: mark this session ${s}`,
  cmdClear: 'Waypoint: clear this session’s status',
  cmdFresh: 'Waypoint: start fresh from this session',
  noSession: 'Open a session first.',
  // settings
  settings: 'Settings',
  sClick: 'Clicking the bar',
  sClickCycle: 'Next status',
  sClickCard: 'Open options',
  sHour: 'Reminders arrive at',
  sHide: 'Show grey bars only on hover',
  sStale: 'Mark Working/Waiting as stale after (days)',
  sLabels: 'Rename the states',
  sBackup: 'Backup',
  sExport: 'Copy backup to clipboard',
  sImport: 'Restore from backup',
  sImportPh: 'Paste a backup here',
  sExported: 'Backup copied to clipboard.',
  sImported: 'Backup restored.',
  sImportBad: 'That is not a valid Waypoint backup.',
  about: 'Data stays on this computer and is never sent to the agent.',
  sBanner: 'Show “where you stopped” above the message box',
  sDigest: 'Morning summary (once a day)',
  bannerWip: n => `Where you stopped: ${n}`,
  bannerWipEmpty: 'You marked this Working. What is the next step?',
  bannerWaiting: (who, when) => `Waiting on ${who}${when ? ` · ${when}` : ''}`,
  bannerDone: 'You marked this Done. A fresh session keeps things fast and focused.',
  insert: 'Insert',
  addNote: 'Add note',
  backToWorking: 'Back to Working',
  reopen: 'Reopen',
  dismiss: 'Dismiss',
  digestTitle: 'Today in Waypoint',
  digestMsg: c => `${c.wip} working${c.stale ? ` (${c.stale} stale)` : ''} · ${c.waiting} waiting${c.due ? ` (${c.due} due)` : ''}`,
  openBoard: 'Open board'
}

const AR = {
  name: 'Waypoint',
  board: 'لوحة الحالة',
  state: { none: 'بدون حالة', wip: 'شغّال', waiting: 'بانتظار', done: 'خلص' },
  hint: {
    none: 'ما في حالة بعد.',
    wip: 'إنت بنص هالشغلة.',
    waiting: 'واقفة على حدا تاني.',
    done: 'أخدت يلي بدك ياه. المرة الجاية ابدأ جلسة جديدة.'
  },
  nextStep: 'الخطوة الجاية (وين وقفت)',
  nextStepPh: 'مثلاً: رندر النسخة العربية',
  who: 'ناطر مين / شو؟',
  whoPh: 'مثلاً: أحمد — أوراق الشحن',
  remindMe: 'ذكّرني',
  remind: { keep: 'متل ما هو', due: 'هلّق', '1d': 'بكرا', '3d': '٣ أيام', '7d': 'جمعة', none: 'بلا' },
  currentReminder: d => `التذكير: ${d}`,
  outcome: 'النتيجة (اختياري)',
  outcomePh: 'مثلاً: انقبلت النسخة النهائية',
  freshStart: 'ابدأ جلسة جديدة',
  freshStartTip: 'بتفتح جلسة جديدة مع رابط لهالجلسة، حتى يقدر الوكيل ياخد السياق.',
  archive: 'أرشفة',
  archived: 'انأرشفت الجلسة',
  undo: 'تراجع',
  save: 'حفظ',
  close: 'سكّر',
  keys: 'Enter للحفظ · Esc للإغلاق',
  tipClickCycle: 'كبسة: الحالة الجاية · كبسة يمين: خيارات',
  tipClickCard: 'كبسة: خيارات',
  waitingOn: who => `ناطر: ${who}`,
  waitingSomeone: 'ناطر حدا',
  reminderAt: d => `تذكير ${d}`,
  followUpNow: 'تابع هلّق!',
  stale: d => `ما انلمست من ${d}`,
  followUp: 'تابع',
  followUpMsg: (who, title) => (title ? `${who} — ${title}` : who),
  openSession: 'افتح الجلسة',
  remindTomorrow: 'ذكّرني بكرا',
  boardSub: 'كل الجلسات يلي ماشي فيها، بمحل واحد.',
  dueNow: 'متابعات مستحقة',
  noneDue: 'ما في متابعات مستحقة.',
  empty: 'ما في شي هون.',
  triage: 'فرز سريع',
  triageSub: 'جلسات جديدة بلا حالة. كبسة وحدة لكل وحدة.',
  triageDone: 'كل الجلسات الأخيرة إلها حالة.',
  skip: 'تخطّي',
  archiveDone: n => `أرشف ${n} خالصين`,
  archiveDoneTitle: n => `أرشفة ${n} جلسات خالصة؟`,
  archiveDoneDesc: 'بتختفي من الشريط بس ما بينمحى شي — بتلاقيها بالجلسات المؤرشفة.',
  untitled: 'جلسة بلا عنوان',
  setAgo: d => `من ${d}`,
  barTip: c => `شغّال ${c.wip} · بانتظار ${c.waiting}${c.due ? ` (${c.due} مستحق)` : ''} · خلص ${c.done}`,
  cmdBoard: 'Waypoint: افتح لوحة الحالة',
  cmdMark: s => `Waypoint: علّم هالجلسة ${s}`,
  cmdClear: 'Waypoint: امسح حالة هالجلسة',
  cmdFresh: 'Waypoint: ابدأ جلسة جديدة من هون',
  noSession: 'افتح جلسة أول.',
  settings: 'الإعدادات',
  sClick: 'الكبس على الشريط',
  sClickCycle: 'الحالة الجاية',
  sClickCard: 'افتح الخيارات',
  sHour: 'وقت التذكير',
  sHide: 'أظهر الأشرطة الرمادية بس عند المرور',
  sStale: 'اعتبر الشغلة قديمة بعد (أيام)',
  sLabels: 'غيّر أسماء الحالات',
  sBackup: 'نسخة احتياطية',
  sExport: 'انسخ النسخة الاحتياطية',
  sImport: 'استرجاع من نسخة',
  sImportPh: 'الصق النسخة هون',
  sExported: 'انتسخت النسخة الاحتياطية.',
  sImported: 'رجعت البيانات.',
  sImportBad: 'هيدي مش نسخة Waypoint صالحة.',
  about: 'البيانات بتضل على هالكمبيوتر وما بتنبعت للوكيل.',
  sBanner: 'أظهر «وين وقفت» فوق مربع الرسالة',
  sDigest: 'ملخص الصبح (مرة باليوم)',
  bannerWip: n => `وين وقفت: ${n}`,
  bannerWipEmpty: 'علّمتها شغّال. شو الخطوة الجاية؟',
  bannerWaiting: (who, when) => `ناطر ${who}${when ? ` · ${when}` : ''}`,
  bannerDone: 'علّمتها خلص. جلسة جديدة بتخلّي الشغل أسرع وأوضح.',
  insert: 'حطّها',
  addNote: 'زيد ملاحظة',
  backToWorking: 'رجّعها شغّال',
  reopen: 'افتحها من جديد',
  dismiss: 'سكّر',
  digestTitle: 'اليوم بـ Waypoint',
  digestMsg: c => `${c.wip} شغّال${c.stale ? ` (${c.stale} قديم)` : ''} · ${c.waiting} بانتظار${c.due ? ` (${c.due} مستحق)` : ''}`,
  openBoard: 'افتح اللوحة'
}

// =====================================================================
// Runtime state (nanostores atoms) + persistence
// =====================================================================

const $snap = atom(normalise({}))
const $now = atom(Date.now())
const $titles = atom({}) // durable id -> title
const $openCard = atom(null) // durable id whose card is open (one at a time)
let ctxRef = null

const KEYS = ['statuses', 'waits', 'meta', 'settings', 'skipped', 'digestDay']

function load(ctx) {
  const raw = {}
  for (const k of KEYS) raw[k] = ctx.storage.get(k, undefined)
  $snap.set(normalise(raw))
}

function commit(next) {
  const prev = $snap.get()
  $snap.set(next)
  if (!ctxRef) return
  for (const k of KEYS) if (prev[k] !== next[k]) ctxRef.storage.set(k, next[k])
}

function T() {
  return ctxRef?.i18n?.t ? (key, ...a) => ctxRef.i18n.t(key, ...a) : (key, ...a) => lookup(EN, key, a)
}

function lookup(bundle, key, args) {
  const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), bundle)
  return typeof v === 'function' ? v(...args) : (v ?? key)
}

function label(t, settings, s) {
  return (s !== 'none' && settings.labels[s]) || t(`state.${s}`)
}

function setStatus(id, next) {
  commit(applyStatus($snap.get(), id, next))
}

function patchWait(id, patch) {
  const snap = $snap.get()
  const cur = snap.waits[id] || { who: '', remindAt: null, notified: false }
  commit({ ...snap, waits: { ...snap.waits, [id]: { ...cur, ...patch } } })
}

function patchMeta(id, patch) {
  const snap = $snap.get()
  const cur = snap.meta[id] || { setAt: Date.now(), next: '', outcome: '' }
  commit({ ...snap, meta: { ...snap.meta, [id]: { ...cur, ...patch } } })
}

function patchSettings(patch) {
  const snap = $snap.get()
  commit({ ...snap, settings: { ...snap.settings, ...patch } })
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ---- sessions: titles + navigation + archive + fresh start -----------------

async function refreshTitles() {
  try {
    const res = await host.request('session.list', { limit: 300 })
    const rows = res?.sessions || []
    const map = {}
    const order = []
    for (const r of rows) {
      const durable = r._lineage_root_id || r.id
      if (!map[durable]) order.push(durable)
      map[durable] = r.title || map[durable] || ''
      map[r.id] = map[r.id] || r.title || ''
    }
    $titles.set(map)
    $recent.set(order)
  } catch {
    // Older gateway or offline: titles just stay unknown.
  }
}

const $recent = atom([]) // durable ids, most recent first (from session.list)

function openSession(id) {
  // host.openSession is the SDK's real "open this chat" (hydrates + focuses);
  // older builds without it fall back to the session route.
  if (typeof host.openSession === 'function') {
    host.openSession(id).catch(() => host.navigate('/' + encodeURIComponent(id)))
  } else {
    host.navigate('/' + encodeURIComponent(id))
  }
}

async function archiveSession(id, archived = true) {
  try {
    await host.request('session.archive', { session_id: id, archived })
    return true
  } catch (e) {
    host.notify({ kind: 'error', message: String(e?.message || e) })
    return false
  }
}

async function archiveWithUndo(id) {
  const t = T()
  if (!(await archiveSession(id, true))) return
  host.notify({
    kind: 'info',
    message: t('archived'),
    action: { label: t('undo'), onClick: () => archiveSession(id, false) }
  })
  refreshTitles()
}

async function freshStart(id) {
  const snap = $snap.get()
  const profile = host.state.profile.get() || 'default'
  const text = handoffText({
    id,
    profile,
    title: $titles.get()[id] || '',
    next: snap.meta[id]?.next || '',
    outcome: snap.meta[id]?.outcome || ''
  })
  const ran = ctxRef?.runAction?.('session.new')
  if (!ran || ran.ok === false) host.navigate('/')
  // The fresh composer mounts asynchronously; keep offering the draft briefly.
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 160))
    try {
      if (await host.composer.setDraft('new', text)) {
        host.composer.focus('new')
        return true
      }
    } catch {}
  }
  try {
    await host.composer.setDraft(null, text)
  } catch {}
  return false
}

// ---- reminders ---------------------------------------------------------------

let shellReady = false

function checkReminders() {
  const now = Date.now()
  $now.set(now)
  if (!shellReady) return
  maybeDigest(now)
  const snap = $snap.get()
  const due = dueToNotify(snap.waits, snap.statuses, now)
  if (!due.length) return
  const t = T()
  const titles = $titles.get()
  const waits = { ...snap.waits }
  for (const id of due) {
    const who = waits[id].who || t('waitingSomeone')
    const msg = t('followUpMsg', who, titles[id] || '')
    host.notify({
      kind: 'info',
      title: t('followUp'),
      message: msg,
      durationMs: 10 * 60 * 1000,
      action: { label: t('openSession'), onClick: () => openSession(id) },
      secondaryAction: {
        label: t('remindTomorrow'),
        onClick: () =>
          patchWait(id, { remindAt: remindAtFor('1d', Date.now(), $snap.get().settings.remindHour), notified: false })
      }
    })
    try {
      ctxRef?.os?.notify?.({ title: `${t('name')}: ${t('followUp')}`, body: msg, activate: '/' + encodeURIComponent(id) })
    } catch {}
    waits[id] = { ...waits[id], notified: true }
  }
  commit({ ...snap, waits })
}

function maybeDigest(now) {
  const snap = $snap.get()
  if (!digestDue(snap, now)) return
  const t = T()
  host.notify({
    kind: 'info',
    title: t('digestTitle'),
    message: t('digestMsg', counts(snap, now)),
    durationMs: 60 * 1000,
    action: { label: t('openBoard'), onClick: () => host.navigate(ROUTE) }
  })
  commit({ ...snap, digestDay: dayKey(now) })
}

// =====================================================================
// UI
// =====================================================================

const COLORS = {
  none: 'var(--ui-text-quaternary)',
  wip: 'var(--ui-yellow, #e0b000)',
  waiting: 'var(--ui-purple, #a371f7)',
  done: 'var(--ui-green, #2ea043)'
}

function stop(e) {
  e.stopPropagation()
}

// Popover content is portaled, but React still bubbles synthetic events to the
// row — swallow them so typing/clicking inside never opens or drags the session.
const SWALLOW = {
  onClick: stop,
  onPointerDown: stop,
  onMouseDown: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
  onKeyDown: stop
}

function Dot({ s, size = 8 }) {
  return jsx('span', {
    'aria-hidden': 'true',
    style: {
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: 999,
      flexShrink: 0,
      background: COLORS[s],
      opacity: s === 'none' ? 0.5 : 1
    }
  })
}

function StatusChips({ value, onPick, settings, t }) {
  return jsx('div', {
    className: 'flex flex-wrap gap-1',
    role: 'radiogroup',
    children: STATES.map((s, i) =>
      jsxs(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': value === s,
          title: `${i + 1}`,
          'data-state-id': s,
          onClick: e => {
            e.stopPropagation()
            onPick(s)
          },
          className:
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-(--chrome-action-hover)',
          style: {
            borderColor: value === s ? COLORS[s] : 'var(--ui-stroke-secondary)',
            color: value === s ? 'var(--foreground)' : 'var(--ui-text-secondary)'
          },
          children: [
            jsx(Dot, { s }),
            jsx('span', { children: label(t, settings, s) })
          ]
        },
        s
      )
    )
  })
}

/** The status card: all states + the note/reminder for the chosen one + actions. */
function StatusCard({ id, onClose }) {
  const t = usePluginI18n(ID)
  const snap = useValue($snap)
  const titles = useValue($titles)
  const status = snap.statuses[id] || 'none'
  const wait = snap.waits[id]
  const meta = snap.meta[id] || {}
  const [draft, setDraft] = useState(status)
  const [next, setNext] = useState(meta.next || '')
  const [outcome, setOutcome] = useState(meta.outcome || '')
  const [who, setWho] = useState(wait?.who || '')
  const [remind, setRemind] = useState(wait?.remindAt ? 'keep' : wait ? 'none' : '1d')

  const remindOptions = useMemo(() => {
    const base = ['1d', '3d', '7d', 'none'].map(k => ({ id: k, label: t(`remind.${k}`) }))
    return wait?.remindAt ? [{ id: 'keep', label: t(wait.notified ? 'remind.due' : 'remind.keep') }, ...base] : base
  }, [wait?.remindAt, wait?.notified, t])

  const save = () => {
    let s = $snap.get()
    if (draft !== status) s = applyStatus(s, id, draft)
    if (draft === 'wip' || draft === 'done') {
      const cur = s.meta[id] || { setAt: Date.now(), next: '', outcome: '' }
      s = { ...s, meta: { ...s.meta, [id]: { ...cur, next: next.trim(), outcome: outcome.trim() } } }
    }
    if (draft === 'waiting') {
      const cur = s.waits[id] || { who: '', remindAt: null, notified: false }
      const remindAt = remind === 'keep' ? cur.remindAt : remindAtFor(remind, Date.now(), s.settings.remindHour)
      const notified = remind === 'keep' ? cur.notified : false
      s = { ...s, waits: { ...s.waits, [id]: { who: who.trim(), remindAt, notified } } }
    }
    commit(s)
    onClose()
  }

  const onKey = e => {
    e.stopPropagation()
    const typing = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      onClose()
    } else if (!typing && /^[1-4]$/.test(e.key)) {
      setDraft(STATES[Number(e.key) - 1])
    }
  }

  const title = titles[id]
  return jsxs('div', {
    ...SWALLOW,
    onKeyDown: onKey,
    dir: 'auto',
    'data-waypoint-card': id,
    className: 'flex flex-col gap-2.5 p-1 text-xs',
    children: [
      title
        ? jsx('div', { className: 'truncate text-[0.6875rem] text-(--ui-text-tertiary)', title, children: title })
        : null,
      jsx(StatusChips, { value: draft, onPick: setDraft, settings: snap.settings, t }),
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: t(`hint.${draft}`) }),

      draft === 'wip'
        ? jsxs(Fragment, {
            children: [
              jsx('label', { className: 'font-medium text-foreground', children: t('nextStep') }),
              jsx(Input, {
                autoFocus: true,
                value: next,
                placeholder: t('nextStepPh'),
                onChange: e => setNext(e.target.value),
                'data-field': 'next'
              })
            ]
          })
        : null,

      draft === 'waiting'
        ? jsxs(Fragment, {
            children: [
              jsx('label', { className: 'font-medium text-foreground', children: t('who') }),
              jsx(Input, {
                autoFocus: true,
                value: who,
                placeholder: t('whoPh'),
                onChange: e => setWho(e.target.value),
                'data-field': 'who'
              }),
              jsx('div', { className: 'text-(--ui-text-tertiary)', children: t('remindMe') }),
              jsx(SegmentedControl, { options: remindOptions, value: remind, onChange: setRemind }),
              wait?.remindAt
                ? jsx('div', {
                    className: 'text-(--ui-text-quaternary)',
                    children: t('currentReminder', fmtDate(wait.remindAt))
                  })
                : null
            ]
          })
        : null,

      draft === 'done'
        ? jsxs(Fragment, {
            children: [
              jsx('label', { className: 'font-medium text-foreground', children: t('outcome') }),
              jsx(Input, {
                autoFocus: true,
                value: outcome,
                placeholder: t('outcomePh'),
                onChange: e => setOutcome(e.target.value),
                'data-field': 'outcome'
              }),
              jsxs('div', {
                className: 'flex flex-wrap gap-1.5',
                children: [
                  jsx(
                    Tip,
                    {
                      label: t('freshStartTip'),
                      children: jsxs(Button, {
                        size: 'sm',
                        variant: 'secondary',
                        'data-action': 'fresh',
                        onClick: () => {
                          save()
                          freshStart(id)
                        },
                        children: [jsx(Codicon, { name: 'add', size: '0.75rem' }), t('freshStart')]
                      })
                    },
                    'fresh'
                  ),
                  jsxs(
                    Button,
                    {
                      size: 'sm',
                      variant: 'ghost',
                      'data-action': 'archive',
                      onClick: () => {
                        save()
                        archiveWithUndo(id)
                      },
                      children: [jsx(Codicon, { name: 'archive', size: '0.75rem' }), t('archive')]
                    },
                    'archive'
                  )
                ]
              })
            ]
          })
        : null,

      jsxs('div', {
        className: 'mt-0.5 flex items-center justify-between gap-2',
        children: [
          jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: t('keys') }),
          jsxs('div', {
            className: 'flex gap-1.5',
            children: [
              jsx(Button, { key: 'c', size: 'sm', variant: 'ghost', onClick: onClose, children: t('close') }),
              jsx(Button, { key: 's', size: 'sm', onClick: save, 'data-action': 'save', children: t('save') })
            ]
          })
        ]
      })
    ]
  })
}

/** Place the card just OUTSIDE the sidebar, next to its row — never covering the
 *  session list. Works for LTR, RTL and a swapped (right-hand) sidebar. */
function cardPlacement(id) {
  try {
    const el = document.querySelector(`[data-waypoint-id="${CSS.escape(id)}"]`)
    if (!el) return { side: document.documentElement.dir === 'rtl' ? 'left' : 'right', offset: 8 }
    const bar = el.getBoundingClientRect()
    const side = bar.left > window.innerWidth / 2 ? 'left' : 'right'
    let pane = el.parentElement
    while (pane && pane !== document.body) {
      const r = pane.getBoundingClientRect()
      if (r.height > window.innerHeight * 0.5 && r.width >= 160 && r.width < window.innerWidth * 0.6) break
      pane = pane.parentElement
    }
    if (!pane || pane === document.body) return { side, offset: 8 }
    const r = pane.getBoundingClientRect()
    const gap = side === 'right' ? r.right - bar.right : bar.left - r.left
    return { side, offset: Math.max(8, Math.round(gap) + 6) }
  } catch {
    return { side: 'right', offset: 8 }
  }
}

function cardSide(id) {
  return cardPlacement(id).side
}

function tooltipFor(t, snap, id, now) {
  const s = snap.statuses[id] || 'none'
  const mode = snap.settings.clickMode === 'card' ? t('tipClickCard') : t('tipClickCycle')
  const name = label(t, snap.settings, s)
  const bits = [name]
  if (s === 'wip' && snap.meta[id]?.next) bits.push(`→ ${snap.meta[id].next}`)
  if (s === 'done' && snap.meta[id]?.outcome) bits.push(`✓ ${snap.meta[id].outcome}`)
  if (s === 'waiting') {
    const w = snap.waits[id]
    bits.push(w?.who ? t('waitingOn', w.who) : t('waitingSomeone'))
    if (w?.remindAt) bits.push(isDue(w, now) ? t('followUpNow') : t('reminderAt', fmtDate(w.remindAt)))
  }
  if (isStale(snap, id, now)) bits.push(t('stale', ago(snap.meta[id].setAt, now)))
  return `${bits.join(' · ')}\n${mode}`
}

/** The bar in each sidebar row. */
function StatusBar({ sessionId: id }) {
  const t = usePluginI18n(ID)
  const snap = useValue($snap)
  const now = useValue($now)
  const openId = useValue($openCard)
  const open = openId === id
  const s = snap.statuses[id] || 'none'
  const due = s === 'waiting' && isDue(snap.waits[id], now)
  const stale = isStale(snap, id, now)

  const setOpen = v => $openCard.set(v ? id : $openCard.get() === id ? null : $openCard.get())

  const onClick = e => {
    e.preventDefault() // also stops the Popover trigger's own toggle
    e.stopPropagation()
    if (e.shiftKey || snap.settings.clickMode === 'card') {
      setOpen(!open)
      return
    }
    const n = nextState(s)
    setStatus(id, n)
    if (n === 'waiting') setOpen(true) // ask who/when right away
  }

  const onContextMenu = e => {
    e.preventDefault()
    e.stopPropagation()
    setOpen(!open)
  }

  const hidden = s === 'none' && snap.settings.hideUnset && !open
  const button = jsx('button', {
    type: 'button',
    'aria-label': `${t('name')}: ${label(t, snap.settings, s)}`,
    'data-waypoint-bar': s,
    'data-waypoint-id': id,
    className:
      'inline-flex h-4 w-2.5 shrink-0 items-center justify-center self-center rounded-sm hover:bg-(--chrome-action-hover)' +
      (hidden ? ' opacity-0 group-hover:opacity-100 focus-visible:opacity-100' : ''),
    onPointerDown: stop,
    onMouseDown: stop,
    onDoubleClick: stop,
    onKeyDown: stop,
    onContextMenu,
    onClick,
    children: jsx('span', {
      'aria-hidden': 'true',
      className: due ? 'animate-pulse' : undefined,
      style: {
        display: 'block',
        width: due ? 5 : 4,
        height: 14,
        borderRadius: 2,
        background: s === 'none' ? 'transparent' : COLORS[s],
        border: s === 'none' ? `1px solid ${COLORS.none}` : stale ? '1px dashed var(--foreground)' : 'none',
        opacity: s === 'none' ? 0.45 : stale ? 0.7 : 1,
        boxSizing: 'border-box'
      }
    })
  })

  return jsxs(Popover, {
    open,
    onOpenChange: v => {
      if (!v) setOpen(false)
    },
    children: [
      jsx(Tip, {
        side: cardSide(id) === 'left' ? 'left' : 'right',
        label: jsx('span', { style: { whiteSpace: 'pre-line' }, children: tooltipFor(t, snap, id, now) }),
        children: jsx(PopoverTrigger, { asChild: true, children: button })
      }),
      open
        ? jsx(PopoverContent, {
            side: cardSide(id),
            sideOffset: cardPlacement(id).offset,
            align: 'start',
            collisionPadding: 8,
            style: { width: 396, maxWidth: 'calc(100vw - 24px)' },
            ...SWALLOW,
            children: jsx(StatusCard, { id, onClose: () => setOpen(false) })
          })
        : null
    ]
  })
}

// ---- "where you stopped" banner above the composer --------------------------

const $bannerDismissed = atom({}) // id -> status it was dismissed at (per app run)

function BannerButton({ onClick, children, primary }) {
  return jsx('button', {
    type: 'button',
    onClick,
    className:
      'shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] transition-colors hover:bg-(--chrome-action-hover)' +
      (primary ? ' font-medium text-foreground' : ' text-(--ui-text-tertiary)'),
    children
  })
}

function ResumeBanner() {
  const t = usePluginI18n(ID)
  const id = useValue(host.state.focusedStoredSessionId)
  const snap = useValue($snap)
  const now = useValue($now)
  const dismissed = useValue($bannerDismissed)
  if (!id || !snap.settings.banner) return null
  const s = snap.statuses[id]
  if (!s || dismissed[id] === s) return null
  const m = snap.meta[id] || {}
  const w = snap.waits[id]

  let text = ''
  const actions = []
  if (s === 'wip') {
    text = m.next ? t('bannerWip', m.next) : t('bannerWipEmpty')
    if (m.next)
      actions.push(jsx(BannerButton, { primary: true, onClick: () => host.composer.insertText(null, m.next), children: t('insert') }, 'ins'))
    else actions.push(jsx(BannerButton, { primary: true, onClick: () => $openCard.set(id), children: t('addNote') }, 'note'))
  } else if (s === 'waiting') {
    const when = w?.remindAt ? (isDue(w, now) ? t('followUpNow') : t('reminderAt', fmtDate(w.remindAt))) : ''
    text = t('bannerWaiting', w?.who || t('waitingSomeone'), when)
    actions.push(jsx(BannerButton, { primary: true, onClick: () => setStatus(id, 'wip'), children: t('backToWorking') }, 'back'))
  } else if (s === 'done') {
    text = t('bannerDone')
    actions.push(jsx(BannerButton, { primary: true, onClick: () => freshStart(id), children: t('freshStart') }, 'fresh'))
    actions.push(jsx(BannerButton, { onClick: () => setStatus(id, 'wip'), children: t('reopen') }, 'reopen'))
  }
  actions.push(
    jsx(
      BannerButton,
      { onClick: () => $bannerDismissed.set({ ...$bannerDismissed.get(), [id]: s }), children: jsx(Codicon, { name: 'close', size: '0.7rem' }) },
      'x'
    )
  )

  return jsxs('div', {
    'data-waypoint-banner': s,
    dir: 'auto',
    className: 'flex min-w-0 items-center gap-2 px-1 pb-1 text-[0.6875rem] text-(--ui-text-secondary)',
    children: [
      jsx('span', {
        'aria-hidden': 'true',
        style: { width: 3, height: 14, borderRadius: 2, background: COLORS[s], flexShrink: 0 }
      }),
      jsx('span', { className: 'min-w-0 flex-1 truncate', title: text, children: text }),
      ...actions
    ]
  })
}

// ---- status bar counter ------------------------------------------------------

function Counter() {
  const t = usePluginI18n(ID)
  const snap = useValue($snap)
  const now = useValue($now)
  const c = counts(snap, now)
  if (!c.wip && !c.waiting && !c.done) return null
  return jsx(Tip, {
    label: t('barTip', c),
    children: jsxs('button', {
      type: 'button',
      'data-waypoint-counter': '',
      onClick: () => host.navigate(ROUTE),
      className:
        'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
      children: [
        jsx(Dot, { s: 'wip', size: 6 }),
        jsx('span', { children: c.wip }),
        jsx(Dot, { s: 'waiting', size: 6 }),
        jsx('span', {
          className: c.due ? 'animate-pulse' : undefined,
          style: c.due ? { color: COLORS.waiting, fontWeight: 600 } : undefined,
          children: c.due ? `${c.waiting}!` : c.waiting
        })
      ]
    })
  })
}

// ---- board page --------------------------------------------------------------

function BoardItem({ id, t, snap, titles, now }) {
  const s = snap.statuses[id] || 'none'
  const w = snap.waits[id]
  const m = snap.meta[id] || {}
  const due = s === 'waiting' && isDue(w, now)
  const stale = isStale(snap, id, now)
  const title = titles[id] || t('untitled')
  const sub =
    s === 'waiting'
      ? [w?.who ? t('waitingOn', w.who) : t('waitingSomeone'), w?.remindAt ? (due ? t('followUpNow') : t('reminderAt', fmtDate(w.remindAt))) : '']
      : s === 'wip'
        ? [m.next ? `→ ${m.next}` : '']
        : [m.outcome ? `✓ ${m.outcome}` : '']

  return jsxs('div', {
    'data-board-item': id,
    className: 'group flex flex-col gap-1 rounded-lg border p-2.5 text-xs',
    style: {
      borderColor: due ? COLORS.waiting : 'var(--ui-stroke-secondary)',
      background: 'color-mix(in srgb, var(--ui-bg-elevated, transparent) 60%, transparent)'
    },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Dot, { s }),
          jsx('button', {
            type: 'button',
            className: 'min-w-0 flex-1 truncate text-left font-medium text-foreground hover:underline',
            title,
            onClick: () => openSession(id),
            children: title
          }),
          jsx('span', {
            className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
            children: m.setAt ? t('setAgo', ago(m.setAt, now)) : ''
          })
        ]
      }),
      sub.filter(Boolean).length
        ? jsx('div', {
            dir: 'auto',
            className: 'text-(--ui-text-tertiary)',
            style: {
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              ...(due ? { color: COLORS.waiting } : {})
            },
            children: sub.filter(Boolean).join(' · ')
          })
        : null,
      stale ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('stale', ago(m.setAt, now)) }) : null,
      jsxs('div', {
        className: 'mt-1 flex flex-wrap items-center gap-1',
        children: [
          ...STATES.filter(x => x !== s && x !== 'none').map(x =>
            jsxs(
              'button',
              {
                type: 'button',
                'data-move': x,
                onClick: () => {
                  setStatus(id, x)
                  if (x === 'waiting') $openCard.set(id)
                },
                className:
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
                style: { borderColor: 'var(--ui-stroke-secondary)' },
                children: [jsx(Dot, { s: x, size: 6 }), label(t, snap.settings, x)]
              },
              x
            )
          ),
          due
            ? jsx(
                'button',
                {
                  type: 'button',
                  onClick: () => patchWait(id, { remindAt: remindAtFor('1d', Date.now(), snap.settings.remindHour), notified: false }),
                  className:
                    'inline-flex items-center rounded border px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
                  style: { borderColor: 'var(--ui-stroke-secondary)' },
                  children: t('remindTomorrow')
                },
                'snooze'
              )
            : null,
          s === 'done'
            ? jsx(
                'button',
                {
                  type: 'button',
                  onClick: () => freshStart(id),
                  className:
                    'inline-flex items-center rounded border px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
                  style: { borderColor: 'var(--ui-stroke-secondary)' },
                  children: t('freshStart')
                },
                'fresh'
              )
            : null
        ]
      })
    ]
  })
}

function Column({ s, ids, t, snap, titles, now, extra }) {
  return jsxs('section', {
    'data-board-column': s,
    className: 'flex min-w-0 flex-1 flex-col gap-2',
    style: { minWidth: 220 },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 text-xs font-medium text-foreground',
        children: [
          jsx(Dot, { s }),
          label(t, snap.settings, s),
          jsx('span', { className: 'text-(--ui-text-quaternary)', children: ids.length }),
          jsx('span', { className: 'flex-1' }),
          extra || null
        ]
      }),
      ids.length
        ? ids.map(id => jsx(BoardItem, { id, t, snap, titles, now }, id))
        : jsx('div', { className: 'py-2 text-xs text-(--ui-text-quaternary)', children: t('empty') })
    ]
  })
}

function sortIds(snap, ids, s, now) {
  return [...ids].sort((a, b) => {
    if (s === 'waiting') {
      const ra = snap.waits[a]?.remindAt || Infinity
      const rb = snap.waits[b]?.remindAt || Infinity
      if (ra !== rb) return ra - rb
    }
    return (snap.meta[b]?.setAt || 0) - (snap.meta[a]?.setAt || 0)
  })
}

function Board() {
  const t = usePluginI18n(ID)
  const snap = useValue($snap)
  const titles = useValue($titles)
  const recent = useValue($recent)
  const now = useValue($now)
  const [confirm, setConfirm] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    refreshTitles()
  }, [])

  const by = { wip: [], waiting: [], done: [] }
  for (const [id, s] of Object.entries(snap.statuses)) if (by[s]) by[s].push(id)
  for (const k of Object.keys(by)) by[k] = sortIds(snap, by[k], k, now)
  const due = by.waiting.filter(id => isDue(snap.waits[id], now))
  const triage = recent.filter(id => !snap.statuses[id] && !snap.skipped.includes(id)).slice(0, 12)
  const c = counts(snap, now)

  const archiveAllDone = async () => {
    for (const id of by.done) {
      if (await archiveSession(id, true)) setStatus(id, 'none')
    }
    refreshTitles()
  }

  return jsxs('div', {
    'data-waypoint-board': '',
    className: 'flex h-full min-h-0 flex-col overflow-auto',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-4 p-5',
        style: { maxWidth: 1200 },
        children: [
          // header
          jsxs('div', {
            className: 'flex flex-wrap items-end gap-3',
            children: [
              jsxs('div', {
                className: 'flex flex-col gap-0.5',
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2 text-base font-semibold text-foreground',
                    children: [jsx(Codicon, { name: 'milestone', size: '1rem' }), `${t('name')} · ${t('board')}`]
                  }),
                  jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: t('boardSub') })
                ]
              }),
              jsx('span', { className: 'flex-1' }),
              jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: t('barTip', c) }),
              jsx(Button, {
                size: 'sm',
                variant: 'ghost',
                onClick: () => setShowSettings(v => !v),
                'data-action': 'settings',
                children: [jsx(Codicon, { name: 'settings-gear', size: '0.8rem' }), t('settings')]
              })
            ]
          }),

          showSettings ? jsx(SettingsPanel, {}) : null,

          // follow-ups due
          due.length
            ? jsxs('section', {
                'data-board-due': '',
                className: 'flex flex-col gap-2 rounded-lg border p-3',
                style: { borderColor: COLORS.waiting },
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2 text-xs font-medium',
                    style: { color: COLORS.waiting },
                    children: [jsx(Codicon, { name: 'bell', size: '0.8rem' }), `${t('dueNow')} (${due.length})`]
                  }),
                  jsx('div', {
                    className: 'grid gap-2',
                    style: { gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' },
                    children: due.map(id => jsx(BoardItem, { id, t, snap, titles, now }, id))
                  })
                ]
              })
            : null,

          // columns
          jsxs('div', {
            className: 'flex flex-wrap items-start gap-4',
            children: [
              jsx(Column, { s: 'wip', ids: by.wip, t, snap, titles, now }, 'wip'),
              jsx(Column, { s: 'waiting', ids: by.waiting, t, snap, titles, now }, 'waiting'),
              jsx(
                Column,
                {
                  s: 'done',
                  ids: by.done,
                  t,
                  snap,
                  titles,
                  now,
                  extra: by.done.length
                    ? jsx(Button, {
                        size: 'sm',
                        variant: 'ghost',
                        'data-action': 'archive-done',
                        onClick: () => setConfirm(true),
                        children: t('archiveDone', by.done.length)
                      })
                    : null
                },
                'done'
              )
            ]
          }),

          // triage
          jsxs('section', {
            'data-board-triage': '',
            className: 'flex flex-col gap-2 border-t pt-4',
            style: { borderColor: 'var(--ui-stroke-secondary)' },
            children: [
              jsxs('div', {
                className: 'flex flex-col gap-0.5',
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2 text-xs font-medium text-foreground',
                    children: [jsx(Codicon, { name: 'filter', size: '0.8rem' }), t('triage')]
                  }),
                  jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: t('triageSub') })
                ]
              }),
              triage.length
                ? triage.map(id =>
                    jsxs(
                      'div',
                      {
                        'data-triage-item': id,
                        className: 'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-(--chrome-action-hover)',
                        children: [
                          jsx('button', {
                            type: 'button',
                            className: 'min-w-0 flex-1 truncate text-left text-foreground',
                            onClick: () => openSession(id),
                            title: titles[id] || t('untitled'),
                            children: titles[id] || t('untitled')
                          }),
                          ...['wip', 'waiting', 'done'].map(x =>
                            jsxs(
                              'button',
                              {
                                type: 'button',
                                'data-triage': x,
                                onClick: () => {
                                  setStatus(id, x)
                                  if (x === 'waiting') $openCard.set(id)
                                },
                                className:
                                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
                                style: { borderColor: 'var(--ui-stroke-secondary)' },
                                children: [jsx(Dot, { s: x, size: 6 }), label(t, snap.settings, x)]
                              },
                              x
                            )
                          ),
                          jsx(
                            'button',
                            {
                              type: 'button',
                              'data-triage': 'skip',
                              onClick: () => commit({ ...$snap.get(), skipped: [...$snap.get().skipped, id].slice(-500) }),
                              className: 'px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-quaternary) hover:text-foreground',
                              children: t('skip')
                            },
                            'skip'
                          )
                        ]
                      },
                      id
                    )
                  )
                : jsx('div', { className: 'py-1 text-xs text-(--ui-text-quaternary)', children: t('triageDone') })
            ]
          }),

          jsx('div', { className: 'pt-2 text-[0.625rem] text-(--ui-text-quaternary)', children: `${t('about')} · v${VERSION}` })
        ]
      }),
      jsx(ConfirmDialog, {
        open: confirm,
        onClose: () => setConfirm(false),
        onConfirm: archiveAllDone,
        title: t('archiveDoneTitle', by.done.length),
        description: t('archiveDoneDesc'),
        confirmLabel: t('archive')
      })
    ]
  })
}

// ---- settings ----------------------------------------------------------------

function Row({ title, children }) {
  return jsxs('div', {
    className: 'flex flex-wrap items-center justify-between gap-3 py-1.5 text-xs',
    children: [jsx('span', { className: 'text-foreground', children: title }), children]
  })
}

function SettingsPanel() {
  const t = usePluginI18n(ID)
  const snap = useValue($snap)
  const st = snap.settings
  const [backup, setBackup] = useState('')

  const hours = [7, 8, 9, 10, 12, 14, 17, 20].map(h => ({ id: String(h), label: `${String(h).padStart(2, '0')}:00` }))

  return jsxs('section', {
    'data-waypoint-settings': '',
    className: 'flex flex-col gap-1 rounded-lg border p-3',
    style: { borderColor: 'var(--ui-stroke-secondary)', maxWidth: 720 },
    children: [
      jsx(Row, {
        title: t('sClick'),
        children: jsx(SegmentedControl, {
          options: [
            { id: 'cycle', label: t('sClickCycle') },
            { id: 'card', label: t('sClickCard') }
          ],
          value: st.clickMode,
          onChange: v => patchSettings({ clickMode: v })
        })
      }),
      jsx(Row, {
        title: t('sHour'),
        children: jsx(SegmentedControl, {
          options: hours,
          value: String(st.remindHour),
          onChange: v => patchSettings({ remindHour: Number(v) })
        })
      }),
      jsx(Row, {
        title: t('sHide'),
        children: jsx(Switch, { checked: st.hideUnset, onCheckedChange: v => patchSettings({ hideUnset: !!v }) })
      }),
      jsx(Row, {
        title: t('sBanner'),
        children: jsx(Switch, { checked: st.banner, onCheckedChange: v => patchSettings({ banner: !!v }) })
      }),
      jsx(Row, {
        title: t('sDigest'),
        children: jsx(Switch, { checked: st.digest, onCheckedChange: v => patchSettings({ digest: !!v }) })
      }),
      jsx(Row, {
        title: t('sStale'),
        children: jsx(SegmentedControl, {
          options: ['3', '7', '14', '30'].map(d => ({ id: d, label: d })),
          value: String(st.staleDays),
          onChange: v => patchSettings({ staleDays: Number(v) })
        })
      }),
      jsx('div', { className: 'pt-2 text-xs font-medium text-foreground', children: t('sLabels') }),
      jsx('div', {
        className: 'grid gap-2',
        style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
        children: ['wip', 'waiting', 'done'].map(s =>
          jsxs(
            'label',
            {
              className: 'flex items-center gap-1.5 text-xs',
              children: [
                jsx(Dot, { s }),
                jsx(Input, {
                  value: st.labels[s],
                  placeholder: t(`state.${s}`),
                  maxLength: 18,
                  onChange: e => patchSettings({ labels: { ...st.labels, [s]: e.target.value } })
                })
              ]
            },
            s
          )
        )
      }),
      jsx('div', { className: 'pt-3 text-xs font-medium text-foreground', children: t('sBackup') }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(Button, {
            size: 'sm',
            variant: 'secondary',
            onClick: async () => {
              const ok = await (ctxRef?.os?.writeClipboard?.(exportPayload($snap.get())) ?? Promise.resolve(false))
              if (!ok) {
                try {
                  await navigator.clipboard.writeText(exportPayload($snap.get()))
                } catch {}
              }
              host.notify({ kind: 'success', message: t('sExported') })
            },
            children: t('sExport')
          }),
          jsx(Input, {
            value: backup,
            placeholder: t('sImportPh'),
            onChange: e => setBackup(e.target.value),
            style: { maxWidth: 260 }
          }),
          jsx(Button, {
            size: 'sm',
            variant: 'ghost',
            disabled: !backup.trim(),
            onClick: () => {
              try {
                commit(importPayload(backup))
                setBackup('')
                host.notify({ kind: 'success', message: t('sImported') })
              } catch {
                host.notify({ kind: 'error', message: t('sImportBad') })
              }
            },
            children: t('sImport')
          })
        ]
      })
    ]
  })
}

// =====================================================================
// Registration
// =====================================================================

function focusedId() {
  return host.state.focusedStoredSessionId?.get?.() || null
}

function markFocused(s) {
  const id = focusedId()
  if (!id) {
    host.notify({ kind: 'info', message: T()('noSession') })
    return
  }
  setStatus(id, s)
  if (s === 'waiting' || s === 'wip') $openCard.set(id)
}

export default {
  id: ID, // must match the folder name
  name: 'Waypoint — Session Status',
  register(ctx) {
    ctxRef = ctx
    ctx.i18n?.register?.({ en: EN, ar: AR })
    load(ctx)

    ctx.registerMany([
      {
        id: 'bar',
        area: SESSION_ROW_AREAS.leading,
        data: { render: ({ sessionId }) => (sessionId ? jsx(StatusBar, { sessionId }) : null) }
      },
      { id: 'page', area: ROUTES_AREA, data: { path: ROUTE }, render: () => jsx(Board, {}) },
      { id: 'counter', area: STATUSBAR_AREAS.right, order: 75, render: () => jsx(Counter, {}) },
      { id: 'banner', area: COMPOSER_AREAS.top, render: () => jsx(ResumeBanner, {}) }
    ])

    const registerLabels = () => {
      const t = T()
      return ctx.registerMany([
        {
          id: 'nav',
          area: SIDEBAR_NAV_AREA,
          order: 55,
          data: { path: ROUTE, label: t('board'), codicon: 'milestone' }
        },
        {
          id: 'cmd-board',
          area: PALETTE_AREA,
          data: { id: 'waypoint.board', label: t('cmdBoard'), keywords: ['status', 'board', 'waypoint', 'waiting', 'follow up'], run: () => host.navigate(ROUTE) }
        },
        ...['wip', 'waiting', 'done'].map(s => ({
          id: `cmd-${s}`,
          area: PALETTE_AREA,
          data: {
            id: `waypoint.mark.${s}`,
            label: t('cmdMark', label(t, $snap.get().settings, s)),
            keywords: ['status', 'mark', 'waypoint', s],
            run: () => markFocused(s)
          }
        })),
        {
          id: 'cmd-clear',
          area: PALETTE_AREA,
          data: { id: 'waypoint.clear', label: t('cmdClear'), keywords: ['status', 'clear', 'waypoint'], run: () => markFocused('none') }
        },
        {
          id: 'cmd-fresh',
          area: PALETTE_AREA,
          data: {
            id: 'waypoint.fresh',
            label: t('cmdFresh'),
            keywords: ['new', 'fresh', 'handoff', 'waypoint', 'continue'],
            run: () => {
              const id = focusedId()
              if (!id) return host.notify({ kind: 'info', message: T()('noSession') })
              setStatus(id, 'done')
              freshStart(id)
            }
          }
        }
      ])
    }
    let disposeLabels = registerLabels()
    ctx.i18n?.onLocaleChange?.(() => {
      disposeLabels()
      disposeLabels = registerLabels()
    })

    refreshTitles()
    // Toasts raised during app boot are dropped (the notification stack isn't
    // mounted yet), so the first reminder sweep waits for the shell to settle.
    $now.set(Date.now())
    shellReady = false
    ctx.setTimeout(() => {
      shellReady = true
      checkReminders()
    }, 6000)
    ctx.setInterval(checkReminders, CHECK_MS)
    ctx.setInterval(refreshTitles, 5 * 60 * 1000)
    ctx.addEventListener?.(window, 'focus', () => checkReminders())
    ctx.onDispose?.(() => {
      ctxRef = null
    })
  }
}
