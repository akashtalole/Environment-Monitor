# Environment Monitor

Tracks Indian environmental approvals – **EIA / EC, ToR, Forest Clearance, Wildlife, CRZ and
State Pollution Control Board consents** – across PARIVESH, the legacy MoEFCC portals, MPCB and
CPCB. It watches a list of projects, records every change it sees, sends alerts and shows
everything on a map dashboard (layout inspired by [World Monitor](https://github.com/koala73/worldmonitor)).

**First focus: pumped storage projects (PSPs) in Maharashtra.**

![Dashboard: map, watchlist with clearance stage bars, activity feed, MPCB hearings, source health](docs/dashboard.png)

## What it monitors

| Source | What it reads | How | Tested |
|---|---|---|---|
| [PARIVESH – Track Your Proposal](https://parivesh.nic.in/newupgrade/#/trackYourProposal) | Proposal status by proposal number (IA/…, SIA/…, FP/…, WL/…) or by name | Headless browser drives the real page and captures its JSON responses | Parsing tested; site was unreachable from the build machine |
| PARIVESH committees | EAC / SEAC / FAC / REC / Wildlife / CRZ agendas & minutes | Public JSON API `parivesh_api/proponentApplicant/getParivesh1AgendaMom` | Parsing tested; site unreachable from the build machine |
| [environmentclearance.nic.in](https://environmentclearance.nic.in/default.aspx) | Legacy EC proposals (pre-PARIVESH 2.0) | ASP.NET form replay on `Search.aspx` | Parsing tested only |
| [forestsclearance.nic.in](https://forestsclearance.nic.in/PartIIReport_A.aspx) | Legacy FC proposal reports (`viewreport.aspx`, `PartIIReport_A.aspx`) | Report page by `?pid=` | Parsing tested only |
| [MPCB](https://www.mpcb.gov.in/en/public-hearing-upcoming) | Upcoming + conducted **EIA public hearings**, Consent Appraisal Committee meetings | HTML tables | ✅ Live |
| [cpc.parivesh.nic.in](https://cpc.parivesh.nic.in/), [CPCB](https://cpcb.nic.in/) | Any new link / notice on the page | Generic page watcher | Needs `caFile` (see below) |

The MPCB connector already finds three Maharashtra PSPs in live data: Malshej Ghat Bhorande
(Adani, 1500 MW), Shirawta (Tata Power, 1800 MW) and Saidongar-2 Maval (Torrent, 1200 MW).

## Quick start

```bash
npm install
npx playwright install chromium   # needed for the PARIVESH Track Your Proposal source
npm run monitor                   # run every source that is due
npm run serve                     # dashboard at http://localhost:8787
```

Keep it running and re-checking every hour:

```bash
npm run serve -- --monitor 60
```

### Run it from India

PARIVESH, CPCB and most `*.nic.in` portals reset connections from outside India. Run the
monitor on a machine or VM in India (a laptop, a small Indian cloud region VM, or a
self-hosted GitHub Actions runner). From elsewhere only the MPCB sources will work, and the
dashboard will show the others as `ERROR` with the reason.

## Adding your projects

The watchlist is [`config/projects.json`](config/projects.json). Each project has keywords
(matched against every source) and, once you know them, proposal numbers:

```bash
# Look a proposal up once (prints status and all fields PARIVESH returns)
npm run track -- IA/MH/RIV/123456/2025
npm run track -- "Bhivpuri"

# Attach it to a watchlist project so it is tracked on every run
node src/cli.js add-id bhivpuri-psp IA/MH/RIV/123456/2025
node src/cli.js add-id bhivpuri-psp FP/MH/HYD/12345/2019 --portal fcLegacy
```

Entries marked `"verified": false` are seeds from public announcements and still need a
proposal number confirmed on a portal.

**Discovery:** records anywhere that mention pumped storage *and* a Maharashtra place name,
but don't match a watchlist project, appear in the dashboard's *Discovered* panel and trigger
alerts. Edit `discovery` in `config/projects.json` to widen this (other states, other sectors).

## Alerts

Set any of these environment variables (or GitHub secrets for the workflow):

| Variable | Effect |
|---|---|
| `ENVMON_WEBHOOK_URL` | POST `{ text, events }` – works with Slack / Discord / Teams incoming webhooks |
| `ENVMON_TELEGRAM_TOKEN` + `ENVMON_TELEGRAM_CHAT_ID` | Telegram bot message |
| `ENVMON_NTFY_TOPIC` | Push via [ntfy](https://ntfy.sh), e.g. `https://ntfy.sh/my-psp-alerts` |

Alerts fire only for watchlist projects and discoveries, and never on a source's first run
(that run records the baseline).

## When PARIVESH changes

PARIVESH has no published API, so the Track Your Proposal connector doesn't hard-code one.
It opens the page in a headless browser, types the query, and reads whatever JSON the page
receives, falling back to the rendered table. To see exactly what the site does:

```bash
npm run probe -- IA/MH/RIV/123456/2025            # add --headed to watch the browser
```

This prints every network call and saves a full dump to `data/raw/parivesh-track/`.
Endpoints seen during normal runs are also logged to `data/raw/parivesh-track/endpoints.json`.
If the search box moves, adjust `searchInputSelectors` in `config/sources.json`.

## Certificate errors

Some `*.nic.in` servers don't send their intermediate certificate. TLS verification is never
disabled; instead add the intermediate as described in [`certs/README.md`](certs/README.md) and
point the source's `caFile` at it.

## Scheduled runs on GitHub

[`.github/workflows/monitor.yml`](.github/workflows/monitor.yml) runs twice a day and commits
`data/` back to the repo. GitHub-hosted runners are outside India, so for full coverage
register a self-hosted runner in India and set the repository variable
`ENVMON_RUNNER=self-hosted`.

## How it works

```
config/sources.json ──► connectors/*  ──► records ──► match to watchlist / discovery
                                                     │
data/snapshots/<source>.json ◄── diff against last run ──► data/events.json ──► alerts
                                                     │
                                         data/dashboard.json ──► web/ (map + panels)
```

- `src/connectors/` – one file per portal; each returns plain records `{ key, title, status, date, proposalNo, docs, fields }`.
- `src/lib/stages.js` – maps free-text statuses onto common stages per track (EC: ToR → public hearing → appraisal → EC granted; FC: Stage-I → Stage-II; WL; CRZ; PCB consent).
- `src/monitor.js` – runs due sources, diffs against the last snapshot, writes events, sends alerts.
- `src/dashboard.js` + `web/` – one JSON file and a static page (MapLibre map, watchlist with stage bars, activity feed, MPCB hearings, discoveries, source health).

```bash
npm test     # parsers (including real MPCB pages), stage rules, matching and diffing
```

## Next steps

- Confirm PARIVESH proposal numbers for the seed projects (run `track` from India).
- Read inside EAC/SEAC/FAC agenda PDFs so projects are matched by the items listed, not just by meeting title.
- More SPCBs (Gujarat, Karnataka, Andhra Pradesh, Madhya Pradesh) and more project types.
