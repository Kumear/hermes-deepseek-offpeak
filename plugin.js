/**
 * deepseek-peak — a Hermes desktop plugin.
 *
 * Shows in the desktop status bar whether the DeepSeek API is in peak hours
 * (double price) or off-peak hours (half price), plus an optional detail panel
 * with the next switch, a 24-hour price timeline and the peak windows in the
 * local timezone.
 *
 * RULE SOURCE: https://api-docs.deepseek.com/quick_start/pricing
 *   "Off-peak rates are half of the peak rates. Peak hours are
 *    01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 *    excluding Chinese public holidays. All other hours are off-peak,
 *    including weekends and Chinese public holidays in full."
 *
 * HOLIDAYS: both peak windows sit inside 09:00-18:00 CST (UTC+8) on the same
 * calendar day they occupy in UTC, so a Chinese public holiday date can be
 * listed as its UTC calendar date. Source (re-published every year):
 * 国务院办公厅 国办发明电〔2025〕7号
 * https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 * Extend CN_HOLIDAYS_UTC when the next year's list appears.
 *
 * COLORS: green dot = cheap (off-peak or holiday), red dot = expensive (peak).
 *
 * CHIP + PANEL: the status-bar chip is the always-on surface. The panel is
 * optional and NOT permanently docked — clicking the chip (or ⌘K ->
 * "DeepSeek Peak: show/hide panel") opens it as a workspace tab next to the
 * chat, and closing it tears down the panel only: plugin and chip stay enabled.
 * Reason: a permanently registered single pane is a trap — closing it makes the
 * app disable the WHOLE plugin (see the ID note below).
 *
 * PORTABLE BY DESIGN: all state math runs in UTC and every displayed time is
 * derived from the device timezone, so the same plugin is correct in any
 * timezone. Display strings live in the single `en` bundle — the plugin i18n
 * resolver falls back to `en` for every other app locale.
 */

import { cn, haptic, host, PALETTE_AREA, Tip, usePluginI18n } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

// The module id is the plugin's identity: the app keys pane placement and its
// "plugin disabled" decision (`hermes.desktop.pluginDecisions.v2`) by it. A
// rename makes the app treat the plugin as brand new — that is the escape hatch
// for a stuck "disabled" entry, but it also orphans the old pane and decision,
// so treat the id as permanent once shipped. The -v2 suffix is such a rename:
// never renumber it again.
const ID = 'deepseek-peak-v2'

// Status colors: the skin's variables when present, with fixed fallbacks.
const COLOR_OFF = 'var(--ui-success, #3fb950)' // cheap
const COLOR_PEAK = 'var(--ui-danger, #f85149)' // expensive
/** Date/time locale for the formatters: English words, 24-hour clock. */
const DATE_LOCALE = 'en-GB'

// ---- logic start (pure, no imports — unit-testable) ------------------------
// Peak windows as [start, end) in minutes since 00:00 UTC.
const PEAK_WINDOWS_UTC = [[60, 240], [360, 600]]
const BOUNDARY_HOURS = [1, 4, 6, 10] // UTC hours at which the price changes

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

const p2 = n => String(n).padStart(2, '0')

function isoDateUTC(d) {
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
}

function isCnHoliday(d) {
  return CN_HOLIDAYS_UTC.has(isoDateUTC(d))
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
  for (const iso of CN_HOLIDAYS_UTC) {
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
    second: '2-digit',
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

function DeepSeekChip() {
  const t = usePluginI18n(ID)
  const now = useNow(1000)
  const state = peakState(now)
  const next = nextTransition(now)
  const left = fmtDuration(next - now.getTime())
  const isPeakNow = state === 'peak'

  return jsx(Tip, {
    label:
      (isPeakNow ? t('chipTipPeak', left) : state === 'holiday' ? t('chipTipHoliday', left) : t('chipTipOff', left)) +
      ' · ' +
      t('panelHint'),
    children: jsxs('button', {
      type: 'button',
      onClick: () => {
        haptic('tap')
        togglePanel()
      },
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'hover:bg-(--chrome-action-hover)'
      ),
      children: [
        jsx(Dot, { key: 'dot', cheap: !isPeakNow }),
        jsx('span', {
          key: 'v',
          className: 'font-medium',
          children: t('chip')
        })
      ]
    })
  })
}

function DeepSeekPane() {
  const t = usePluginI18n(ID)
  const now = useNow(1000)
  const state = peakState(now)
  const next = nextTransition(now)
  const left = fmtDuration(next - now.getTime())
  const isPeakNow = state === 'peak'
  const color = isPeakNow ? COLOR_PEAK : COLOR_OFF

  const w = PEAK_WINDOWS_UTC
  const stateText = isPeakNow ? t('statePeak') : state === 'holiday' ? t('stateHoliday') : t('stateOff')

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 overflow-auto p-3 text-sm',
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
              jsx(Row, { label: t('holidays'), value: holidaySummary(n => t('days', n)) + ' — ' + t('alwaysOff') }),
              jsx('div', {
                className: 'mt-1 text-[0.6875rem] leading-snug text-(--ui-text-quaternary)',
                children: t('source')
              })
            ]
          })
        ]
      })
    ]
  })
}

// ---- panel on demand (not permanently docked) ------------------------------
// A permanently registered single pane is a trap: when the user closes it, the
// app disables the WHOLE plugin — chip included. So the chip click opens an
// openWorkspace panel instead: openWorkspace attaches its own pane closer, so
// closing the tab tears down the panel only.
const PANEL_KEY = 'deepseek-peak-panel'
const PANEL_MIN_WIDTH = '15.5rem' // ≈ 248 px, the width the old pane had

/** Disposer of the open panel; null = closed. */
let panelClose = null

function panelSupported() {
  return typeof host.openWorkspace === 'function'
}

function togglePanel() {
  if (panelClose) {
    const close = panelClose

    panelClose = null
    close()

    return
  }

  if (!panelSupported()) {
    return
  }

  try {
    panelClose = host.openWorkspace(PANEL_KEY, {
      render: () => jsx(DeepSeekPane, {}),
      title: 'DeepSeek Peak',
      // Dock to the right of the chat — like the former placement: 'right'.
      dock: { pane: 'workspace', pos: 'right' },
      minWidth: PANEL_MIN_WIDTH,
      onClose: () => {
        panelClose = null
      }
    })
  } catch (error) {
    panelClose = null
    host.notify({ kind: 'error', message: 'DeepSeek Peak panel: ' + String(error) })
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
        panelHint: 'click opens/closes the panel',
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
        panelCommand: 'DeepSeek Peak: show/hide panel',
        source: 'api-docs.deepseek.com · holidays: gov.cn (国办发明电〔2025〕7号)'
      }
    })

    // No permanently docked pane: it opens on a chip click (openWorkspace, see
    // togglePanel). Only older desktop builds without openWorkspace still get
    // the classic registered pane.
    if (!panelSupported()) {
      ctx.register({
        id: 'pane',
        area: 'panes',
        title: 'DeepSeek Peak',
        data: { placement: 'right', width: '248px' },
        render: () => jsx(DeepSeekPane, {})
      })
    }

    // Palette (⌘K) row. Its label is read at registration time, where a hook
    // cannot reach it: use ctx.i18n.t when the build offers it (newer builds
    // only) and fall back to the English literal.
    ctx.register({
      id: 'panel-command',
      area: PALETTE_AREA,
      data: {
        id: 'deepseek-peak.panel',
        label:
          typeof (ctx.i18n && ctx.i18n.t) === 'function'
            ? ctx.i18n.t('panelCommand')
            : 'DeepSeek Peak: show/hide panel',
        keywords: ['deepseek', 'peak', 'off-peak', 'panel'],
        run: () => togglePanel()
      }
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 135,
      render: () => jsx(DeepSeekChip, {})
    })
  }
}
