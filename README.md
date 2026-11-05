# TechPulse

Auto-updating news hub for **software, AI and cybersecurity** — latest developments, updates and new releases, with a Turkish/English interface.

Yazılım, yapay zeka ve siber güvenlikteki son gelişmeleri, güncellemeleri ve yeni sürümleri saatlik olarak toplayan, TR/EN arayüzlü haber sitesi.

## How it works

```
GitHub Actions (hourly cron)
  └─ scripts/fetch-feeds.mjs  →  fetches ~40 RSS/Atom feeds (scripts/sources.json)
       └─ normalize · dedupe · tag · merge with previous snapshot
            └─ site/data/news.json + meta.json  →  committed  →  deployed to GitHub Pages
```

- No server, no API keys, no CORS proxy. The site is static HTML/CSS/JS in `site/`.
- One broken feed never breaks the run; items from a temporarily failing source are kept from the previous snapshot. Items older than 30 days are dropped.
- Open pages re-check the data every 10 minutes and show a "N new stories" button.

## Features

- Categories: AI · Software · Cybersecurity · New Releases (GitHub releases of VS Code, Node.js, Python, Kubernetes, React, PyTorch, Ollama, LangChain, Transformers, Docker, Next.js) · Turkish sources
- Automatic tags: new release, vulnerability/CVE, breach, open source; "NEW" badge for stories first seen in the last 3 hours
- Search (press `/`), source and time filters, highlights strip, 24-hour stats
- Save stories (stored in your browser), TR/EN toggle, light/dark theme, mobile-friendly

## Setup (one time)

1. Merge this branch into the default branch (`main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions → "Update news & deploy" → Run workflow** for the first update. After that it runs every hour on its own.

The site will be at `https://<user>.github.io/<repo>/`.

## Local development

```bash
npm install
npm run fetch   # pulls feeds into site/data/
npm run dev     # serves site/ at http://localhost:5173
```

## Adding or removing sources

Edit `scripts/sources.json`:

```json
{ "id": "unique-id", "name": "Display name", "url": "https://example.com/feed.xml",
  "category": "ai | software | security | releases", "lang": "en | tr", "site": "example.com", "limit": 20 }
```

Turkish (`lang: "tr"`) items, and sources with `"autoCategory": true`, are re-categorized by keywords (e.g. a Webtekno story about AI goes under AI). The per-source status is listed in the site footer.
