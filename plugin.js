/**
 * hermes-deepseek-offpeak — a Hermes desktop plugin.
 *
 * The status bar gets a chip: a colored dot showing whether the DeepSeek API is
 * in peak hours (double price) or off-peak hours (half price). Hover it for the
 * one-line summary, click it for the detail popover — next switch, a 24-hour
 * price timeline and the peak windows in the local timezone.
 *
 * RULE SOURCE: https://api-docs.deepseek.com/quick_start/pricing
 *   "Off-peak rates are half of the peak rates. Peak hours are
 *    01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 *    excluding Chinese public holidays. All other hours are off-peak,
 *    including weekends and Chinese public holidays in full."
 *
 * HOLIDAYS: both peak windows sit inside 09:00-18:00 CST (UTC+8) on the same
 * calendar day they occupy in UTC, so a Chinese public holiday can be listed as
 * its UTC calendar date. The State Council publishes the next year's
 * arrangement every November: 国务院办公厅 国办发明电〔2025〕7号 (for 2026).
 * CN_HOLIDAYS_UTC is the offline fallback — on load the plugin refreshes the
 * list from a community mirror of that notice (`NateScarlet/holiday-cn` on
 * jsDelivr, one JSON GET per year), caches it for a week and silently keeps the
 * bundled dates when the network or the mirror fails. DeepSeek itself publishes
 * no API for the peak/off-peak state or the calendar — the rule is text on
 * their pricing page, so this is as current as it gets.
 *
 * COLORS: green dot = cheap (off-peak or holiday), red dot = expensive (peak).
 * The dot carries the state; the chip text stays neutral so color is the only
 * thing that changes.
 *
 * PORTABLE BY DESIGN: all state math runs in UTC and every displayed time is
 * derived from the device timezone, so the same plugin is correct in any
 * timezone. Display strings live in the single `en` bundle — the plugin i18n
 * resolver falls back to `en` for every other app locale.
 *
 * ID: the app keys its "plugin disabled" state by this id, so treat it as
 * permanent once shipped. It matches the repository name on purpose.
 */
import {
  Button,
  cn,
  haptic,
  host,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  STATUSBAR_AREAS,
  usePluginI18n
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const ID = 'hermes-deepseek-offpeak'

// Status colors: the skin's variables when present, with fixed fallbacks.
const COLOR_OFF = 'var(--ui-success, #3fb950)' // cheap
const COLOR_PEAK = 'var(--ui-danger, #f85149)' // expensive
/** Date/time locale for the formatters: English words, 24-hour clock. */
const DATE_LOCALE = 'en-GB'

// ---- logic start (pure, no imports — unit-testable) ------------------------
// Peak windows as [start, end) in minutes since 00:00 UTC.
const PEAK_WINDOWS_UTC = [[60, 240], [360, 600]]
// UTC hours at which the price can change — derived, so there is one source.
const BOUNDARY_HOURS = PEAK_WINDOWS_UTC.flat().map(minutes => minutes / 60)

// Chinese public holidays that fall on a weekday (weekends are off-peak
// anyway). Format YYYY-MM-DD, UTC calendar == CST calendar for these dates.
const CN_HOLIDAYS_UTC = new Set([
  '2026-01-01', // New Year (Thu)
  '2026-01-02', // New Year (Fri)
  '2026-02-16', // Spring Festival (Mon)
  '2026-02-17', // Spring Festival (Tue)
  '2026-02-18', // Spring Festival (Wed)
  '2026-02-19', // Spring Festival (Thu)
  '2026-02-20', // Spring Festival (Fri)
  '2026-02-23', // Spring Festival (Mon)
  '2026-04-06', // Qingming (Mon)
  '2026-05-01', // Labour Day (Fri)
  '2026-05-04', // Labour Day (Mon)
  '2026-05-05', // Labour Day (Tue)
  '2026-06-19', // Dragon Boat Festival (Fri)
  '2026-09-25', // Mid-Autumn Festival (Fri)
  '2026-10-01', // National Day (Thu)
  '2026-10-02', // National Day (Fri)
  '2026-10-05', // National Day (Mon)
  '2026-10-06', // National Day (Tue)
  '2026-10-07' // National Day (Wed)
])

// Active holiday set: the bundled list until a live refresh replaces it (see
// refreshHolidays). Only weekday holidays live in here — weekends are off-peak
// anyway, and tagging them "holiday" would misattribute the state.
let cnHolidays = CN_HOLIDAYS_UTC

const p2 = n => String(n).padStart(2, '0')

function isoDateUTC(d) {
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
}

function isCnHoliday(d) {
  return cnHolidays.has(isoDateUTC(d))
}

/** 'peak' | 'off' | 'holiday' */
function peakState(d) {
  const day = d.getUTCDay() // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return 'off'
  if (isCnHoliday(d)) return 'holiday'
  const m = d.getUTCHours() * 60 + d.getUTCMinutes()
  return PEAK_WINDOWS_UTC.some(([s, e]) => m >= s && m < e) ? 'peak' : 'off'
}

function isPeak(d) {
  return peakState(d) === 'peak'
}

// One-line display summary: "2026 · 19 days". The localized day word is passed
// in so nothing hardcoded lives down here.
function holidaySummary(fmtDays) {
  const perYear = {}
  for (const iso of cnHolidays) {
    const y = iso.slice(0, 4)
    perYear[y] = (perYear[y] || 0) + 1
  }
  return Object.keys(perYear)
    .sort()
    .map(y => y + ' · ' + fmtDays(perYear[y]))
    .join(', ')
}

// Next real PRICE change: candidates are the window edges of the next 12 days;
// the first one where peak/off-peak actually flips wins. Compared via isPeak
// (not peakState): off-peak -> holiday changes no price, so it is no switch.
function nextTransition(now) {
  const cur = isPeak(now)
  const y = now.getUTCFullYear()
  const mo = now.getUTCMonth()
  const day = now.getUTCDate()
  for (let off = 0; off <= 12; off++) {
    for (const h of BOUNDARY_HOURS) {
      const t = Date.UTC(y, mo, day + off, h, 0, 0)
      if (t <= now.getTime()) continue
      if (isPeak(new Date(t)) !== cur) return t
    }
  }
  return now.getTime()
}

function fmtDuration(ms) {
  let s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return (d > 0 ? d + 'd ' : '') + p2(h) + ':' + p2(m) + ':' + p2(s)
}

// The one-line status text used by the chip's hover hint and the ⌘K toast.
function summaryFor(t, now) {
  const left = fmtDuration(nextTransition(now) - now.getTime())
  const state = peakState(now)
  return state === 'peak'
    ? t('chipTipPeak', left)
    : state === 'holiday'
      ? t('chipTipHoliday', left)
      : t('chipTipOff', left)
}

function tzOffsetMinutes() {
  return -new Date().getTimezoneOffset()
}

// Minutes since 00:00 UTC -> device-local "HH:MM".
function localHM(minuteOfDayUtc) {
  const v = (((minuteOfDayUtc + tzOffsetMinutes()) % 1440) + 1440) % 1440
  return p2(Math.floor(v / 60)) + ':' + p2(v % 60)
}
function utcHM(minuteOfDay) {
  return p2(Math.floor(minuteOfDay / 60)) + ':' + p2(minuteOfDay % 60)
}

function tzLabel() {
  const o = tzOffsetMinutes()
  const sign = o < 0 ? '-' : '+'
  const a = Math.abs(o)
  return 'UTC' + sign + (a % 60 === 0 ? a / 60 : (a / 60).toFixed(2))
}

// Switch instant: time only when it is on the same local day, else day + date.
function fmtSwitch(ts, now) {
  const d = new Date(ts)
  const sameDay = d.toDateString() === now.toDateString()
  return new Intl.DateTimeFormat(
    DATE_LOCALE,
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
  ).format(d)
}
// ---- logic end -------------------------------------------------------------

function useNow(intervalMs) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function clock(d, timeZone) {
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone
  }).format(d)
}

function Dot({ cheap, size }) {
  return jsx('span', {
    className: cn('inline-block shrink-0 rounded-full', size === 'lg' ? 'h-2.5 w-2.5' : 'h-1.5 w-1.5'),
    style: { backgroundColor: cheap ? COLOR_OFF : COLOR_PEAK }
  })
}

function Row({ label, value, color }) {
  return jsxs('div', {
    className: 'flex items-baseline justify-between gap-2',
    children: [
      jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: label }),
      jsx('span', { className: 'tabular-nums', style: color ? { color } : undefined, children: value })
    ]
  })
}

// 24-hour bar: green = cheap, red = expensive, with a "now" marker.
function Timeline({ now }) {
  const start = new Date(now)
  start.setMinutes(0, 0, 0)
  const t0 = start.getTime()
  const slots = []
  for (let i = 0; i < 24; i++) {
    const mid = new Date(t0 + i * 3600000 + 1800000)
    slots.push(isPeak(mid))
  }
  const pct = ((now.getTime() - t0) / 86400000) * 100
  const label = h => new Intl.DateTimeFormat(DATE_LOCALE, { hour: '2-digit', minute: '2-digit' }).format(new Date(t0 + h * 3600000))

  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'relative',
        children: [
          jsx('div', {
            className: 'flex h-3 w-full gap-px overflow-hidden rounded-sm',
            children: slots.map((p, i) =>
              jsx('div', {
                key: i,
                className: 'flex-1',
                style: { backgroundColor: p ? COLOR_PEAK : COLOR_OFF, opacity: 0.75 }
              })
            )
          }),
          jsx('div', {
            className: 'absolute -top-0.5 h-4 w-0.5',
            style: { left: pct + '%', backgroundColor: 'var(--ui-text-secondary, #b0b0b0)' }
          })
        ]
      }),
      jsxs('div', {
        className: 'flex justify-between text-[0.625rem] text-(--ui-text-quaternary) tabular-nums',
        children: [
          jsx('span', { key: 'a', children: label(0) }),
          jsx('span', { key: 'b', children: label(6) }),
          jsx('span', { key: 'c', children: label(12) }),
          jsx('span', { key: 'd', children: label(18) }),
          jsx('span', { key: 'e', children: label(24) })
        ]
      })
    ]
  })
}

/** Detail view, shown in the chip's popover (click). `now` comes from the chip,
 *  so one timer drives both. */
function DetailPanel({ now, t }) {
  const state = peakState(now)
  const isPeakNow = state === 'peak'
  const next = nextTransition(now)
  const left = fmtDuration(next - now.getTime())
  const color = isPeakNow ? COLOR_PEAK : COLOR_OFF
  const w = PEAK_WINDOWS_UTC
  const stateText = isPeakNow ? t('statePeak') : state === 'holiday' ? t('stateHoliday') : t('stateOff')

  return jsxs('div', {
    className: 'flex flex-col gap-3 text-xs',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Dot, { cheap: !isPeakNow, size: 'lg' }),
          jsx('span', { className: 'font-semibold', style: { color }, children: stateText })
        ]
      }),
      jsx('div', {
        className: 'text-(--ui-text-tertiary)',
        children: isPeakNow ? t('ratePeak') : t('rateOff')
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx(Row, {
            label: t('nextLabel'),
            value: (isPeakNow ? t('startsOff') : t('startsPeak')) + ' ' + fmtSwitch(next, now) + ' · in ' + left
          }),
          jsx(Row, { label: t('localTime'), value: clock(now) }),
          jsx(Row, { label: t('utcTime'), value: clock(now, 'UTC') })
        ]
      }),
      jsxs('div', {
        className: 'border-t border-(--ui-stroke-secondary) pt-2',
        children: [
          jsx('div', {
            className: 'mb-1 text-[0.6875rem] uppercase tracking-wide text-(--ui-text-tertiary)',
            children: t('timelineTitle')
          }),
          jsx(Timeline, { now })
        ]
      }),
      jsxs('div', {
        className: 'border-t border-(--ui-stroke-secondary) pt-2 text-(--ui-text-tertiary)',
        children: [
          jsx('div', {
            className: 'mb-1 text-[0.6875rem] uppercase tracking-wide',
            children: t('windowsTitle', tzLabel())
          }),
          jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsx(Row, {
                label: t('weekdays'),
                value: localHM(w[0][0]) + '–' + localHM(w[0][1]) + ' · ' + localHM(w[1][0]) + '–' + localHM(w[1][1])
              }),
              jsx(Row, {
                label: t('utcLabel'),
                value: utcHM(w[0][0]) + '–' + utcHM(w[0][1]) + ' · ' + utcHM(w[1][0]) + '–' + utcHM(w[1][1])
              }),
              jsx(Row, { label: t('weekend'), value: t('alwaysOff') }),
              jsx(Row, { label: t('holidays'), value: holidaySummary(n => t('days', n)) + ' — ' + t('alwaysOff') })
            ]
          })
        ]
      })
    ]
  })
}

/** Status-bar chip: colored dot + neutral label, wrapped in the popover. */
function DeepSeekChip() {
  const t = usePluginI18n(ID)
  const now = useNow(1000)
  const isPeakNow = peakState(now) === 'peak'
  const summary = summaryFor(t, now)

  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsxs(Button, {
          'aria-label': summary,
          title: summary + ' · ' + t('clickHint'),
          variant: 'ghost',
          size: 'micro',
          className: cn('gap-1.5 px-1.5'),
          onClick: () => haptic('tap'),
          children: [
            jsx(Dot, { key: 'dot', cheap: !isPeakNow }),
            jsx('span', { key: 'label', className: 'font-medium', children: t('chip') })
          ]
        })
      }),
      jsx(PopoverContent, {
        align: 'end',
        side: 'top',
        className: 'w-[19.5rem] p-3',
        children: jsx(DetailPanel, { now, t })
      })
    ]
  })
}

// ---- live holiday list (bundled list above stays the fallback) -------------
const HOLIDAY_REFRESH_MS = 7 * 24 * 3600 * 1000
const HOLIDAY_CACHE_KEY = 'holidays.v1'
/** Community mirror of the State Council notice, one JSON per year. */
const holidayUrls = year => [
  `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`
]

/** Remote data is treated as untrusted input: dates only, no surprises. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isWeekendIso(iso) {
  const day = new Date(iso + 'T00:00:00Z').getUTCDay()
  return day === 0 || day === 6
}

/** Weekday holidays of one year, or [] while that year is not published yet. */
async function fetchHolidayYear(year) {
  for (const url of holidayUrls(year)) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        // Public data, nothing about the user goes out: no cookies, no referrer.
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      })

      if (!res.ok) continue

      const data = await res.json()
      const days = (Array.isArray(data && data.days) ? data.days : [])
        .filter(d => d && d.isOffDay === true && ISO_DATE.test(String((d && d.date) || '')))
        .map(d => d.date)
        .filter(iso => !isWeekendIso(iso))
        .slice(0, 366)

      if (days.length) return days
    } catch (error) {
      // mirror down — the next mirror, or the bundled list, takes over
    }
  }

  return []
}

function applyHolidays(days) {
  if (!days.length) return

  cnHolidays = new Set(days)
}

/**
 * Refresh from the mirror when the cache is stale. Never throws: on any failure
 * the bundled list (or the last good cache) stays in place and the panel's
 * provenance line says so.
 */
async function refreshHolidays(ctx) {
  try {
    const cache = ctx.storage.get(HOLIDAY_CACHE_KEY, null)

    if (cache && Array.isArray(cache.days) && Date.now() - cache.fetchedAt < HOLIDAY_REFRESH_MS) {
      applyHolidays(cache.days)
      return true
    }

    const year = new Date().getUTCFullYear()
    const days = []
    const years = []

    for (const y of [year, year + 1]) {
      const part = await fetchHolidayYear(y)

      if (part.length) {
        days.push(...part)
        years.push(y)
      }
    }

    if (!days.length) throw new Error('no holiday data reachable')

    // Live data is authoritative per year; the bundled list fills the gaps.
    const covered = new Set(years.map(String))
    const kept = [...CN_HOLIDAYS_UTC].filter(iso => !covered.has(iso.slice(0, 4)))

    applyHolidays([...kept, ...days])
    ctx.storage.set(HOLIDAY_CACHE_KEY, { days, years: years.map(String), fetchedAt: Date.now() })
    console.log(`[${ID}] holidays: live ${years.join('+')} (${days.length} weekday holidays)`)

    return true
  } catch (error) {
    console.warn(`[${ID}] holidays: live refresh failed (${String(error)}) — keeping bundled/cached list`)

    return false
  }
}

export default {
  id: ID,
  name: 'DeepSeek Peak',
  register(ctx) {
    ctx.i18n.register({
      en: {
        chip: 'DS',
        chipTipPeak: left => `DeepSeek PEAK — double price. Off-peak in ${left}`,
        chipTipOff: left => `DeepSeek off-peak — half price. Peak in ${left}`,
        chipTipHoliday: left => `DeepSeek off-peak (Chinese public holiday) — half price. Peak in ${left}`,
        clickHint: 'click for details',
        statePeak: 'Peak — expensive',
        stateOff: 'Off-peak — cheap',
        stateHoliday: 'Off-peak — Chinese holiday',
        ratePeak: 'Double price (×2 vs off-peak)',
        rateOff: 'Half price (50 % off)',
        nextLabel: 'Switch',
        startsOff: 'off-peak at',
        startsPeak: 'peak at',
        localTime: 'Local',
        utcTime: 'UTC',
        timelineTitle: 'Next 24 hours',
        windowsTitle: tz => `Peak windows Mon–Fri (${tz})`,
        weekdays: 'Mon–Fri',
        utcLabel: 'UTC',
        weekend: 'Sat + Sun',
        holidays: 'Chinese holidays',
        alwaysOff: 'off-peak all day',
        days: n => n + ' days',
        statusCommand: 'DeepSeek Peak: status'
      }
    })

    // Holiday list: bundled data renders immediately, live data is fetched in
    // the background and swaps in when it lands (never blocks the first paint).
    refreshHolidays(ctx)

    // ⌘K row. Registration runs outside a component, so the label cannot use the
    // i18n hook: ctx.i18n.t resolves it (English literal as the last resort).
    const t0 = typeof (ctx.i18n && ctx.i18n.t) === 'function' ? (key, arg) => ctx.i18n.t(key, arg) : null
    ctx.register({
      id: 'status',
      area: PALETTE_AREA,
      data: {
        id: 'hermes-deepseek-offpeak.status',
        label: t0 ? t0('statusCommand') : 'DeepSeek Peak: status',
        keywords: ['deepseek', 'peak', 'off-peak', 'price', 'status'],
        run: () => {
          const now = new Date()

          haptic('tap')
          host.notify({
            kind: 'info',
            message: t0 ? summaryFor(t0, now) : 'DeepSeek peak/off-peak status: ' + fmtDuration(nextTransition(now) - now.getTime())
          })
        }
      }
    })

    // The chip: dot + label, detail view in its popover — no pane, so closing
    // the detail view can never disable the plugin itself.
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 135,
      render: () => jsx(DeepSeekChip, {})
    })
  }
}
