# DeepSeek Peak — Hermes desktop plugin

A status-bar chip for the [Hermes desktop app](https://hermes-agent.nousresearch.com/docs) that shows
whether the DeepSeek API is currently in **peak** hours (double price) or **off-peak** hours (half
price).

![status-bar chip: green dot and DS](docs/chip.png)

The chip is the plugin: a green dot means cheap (off-peak or Chinese public holiday), red means
expensive (peak). Hovering it shows the state, the price factor and the countdown to the next switch.

Everything else is optional detail — clicking the chip opens the detail popover, and the command
palette (⌘K → `DeepSeek Peak: status`) reports the same state as a notification:

<img src="docs/panel.png" alt="The chip with its detail popover open above it: current state and price, next switch with countdown, local and UTC clock, 24-hour price timeline, peak windows in local time and UTC, holiday note" width="520">

*The chip with its detail popover open above it — on a Chinese public holiday, so off-peak all day.*

| Surface | Content |
| --- | --- |
| Status-bar chip (the point) | `DS` + colored dot, always visible; the tooltip carries state, price factor and the one-second countdown to the next switch. |
| Detail popover (click the chip) | Current state and price, next switch (local time + countdown), 24-hour price timeline, peak windows local and UTC, holiday rules. |
| Command palette | `DeepSeek Peak: status` (⌘K) |

## The rule

From <https://api-docs.deepseek.com/quick_start/pricing>:

> Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC,
> Monday through Friday, excluding Chinese public holidays. All other hours are off-peak, including
> weekends and Chinese public holidays in full.

Both peak windows sit inside 09:00–18:00 CST (UTC+8) on the same calendar day they occupy in UTC, so
a Chinese public holiday can be listed as its UTC calendar date (`CN_HOLIDAYS_UTC`). The list comes
from the State Council's annual notice (2026: 国办发明电〔2025〕7号, see the link in the file header)
and has to be extended once a year.

## Holiday data stays current

DeepSeek publishes **no API** for peak/off-peak state or for the holiday calendar — the rule is text
on their pricing page. The Chinese holiday arrangement is re-published once a year (State Council,
every November), so instead of hardcoding it the plugin:

- ships the current list (`CN_HOLIDAYS_UTC`) as an offline fallback,
- refreshes it from a community mirror of that notice
  ([`NateScarlet/holiday-cn`](https://github.com/NateScarlet/holiday-cn), served via jsDelivr) — one
  JSON GET per year, at most once a week, cached locally,
- keeps the bundled dates whenever the network or the mirror fails, and
- names its source in the panel footer: `live 2026 · updated 3h ago` vs.
  `notice 2026 (bundled) · live refresh failed`.

Nothing is sent anywhere — the refresh is an anonymous GET to a public CDN. As soon as the State
Council publishes the next year's arrangement, it appears automatically: no plugin update needed.

## Timezones

All state math runs in UTC; every displayed time is rendered in the timezone of the machine the app
runs on. The panel shows the windows in local time next to the UTC reference, so the same plugin is
correct anywhere on the planet.

## Install

```bash
git clone https://github.com/Kumear/hermes-deepseek-offpeak.git \
  ~/.hermes/desktop-plugins/hermes-deepseek-offpeak
```

Hermes loads desktop plugins from `~/.hermes/desktop-plugins/<name>/plugin.js` — plain ESM, no build
step, no dependencies (`@hermes/plugin-sdk` comes with the app). The folder name is free; the plugin
identifies itself by the id inside the file. Restart the app if the chip does not show up; after that
the file is hot-reloaded on save.

## Usage notes

- The chip is the only surface the plugin contributes, and the detail view is the chip's own popover:
  nothing to dock, nothing to close, nothing that can switch the plugin off.
- The plugin id (`hermes-deepseek-offpeak`) is the plugin's identity — the app keys its enable/disable
  decision by it, so treat it as permanent once installed.

## Requirements

A Hermes desktop build with the plugin SDK: contribution areas `statusBar.right` and `palette`, the
`Button`/`Popover` components and a locale bundle registry. No build step, no dependencies beyond the
SDK the app ships. Developed and verified against Hermes desktop 0.21.5 on macOS.

## License

MIT — see [LICENSE](LICENSE).
