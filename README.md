# GPS Maintenance Tracker — TASR BharatNext

Single-file HTML PWA for tracking GPS device installations, SIM cards, repairs, and stock inventory for TASR fleet operations.

Current version: **v2.8.3**

## Features

- **Akash Portal** — Field worker view: New install / Report repair / View own entries
- **Admin Portal** — Full management:
  - Home (dashboard with donut charts + activity feed + stock bars)
  - Installations (list + edit + vehicle timeline)
  - Repair Work (list + edit)
  - Repair Progress (pending tasks by category)
  - SIM Database (primary + secondary numbers, with bulk upload)
  - Stock (items by category, supplier, low-stock alerts)
- **PWA installable** — Add to Home Screen, works offline (app shell cached)
- **Camera barcode scanning** — IMEI + ICCID via phone camera (back camera)
- **Excel exports** — Installations, SIMs, Stock, Repair records
- **Realtime sync** — Supabase realtime subscriptions
- **Mobile-first** — Bottom tab bar + FAB + sticky top nav

## Deployment (GitHub Pages)

1. Create a new GitHub repo
2. Upload all files from this folder to the repo root
3. Enable GitHub Pages: Settings → Pages → Source: `main` branch → `/ (root)`
4. URL: `https://<username>.github.io/<repo-name>/`

## Supabase setup

1. Create a Supabase project at https://supabase.com
2. Open SQL Editor and run the migration files **in this order**:
   1. `pending-actions-migration.sql`
   2. `sims-table-migration.sql`
   3. `stock-items-migration.sql`
   4. `stock-transactions-migration.sql`
   5. `stock-items-metadata-migration.sql`
   6. `stock-categories-migration.sql`
   7. `suppliers-and-extras-migration.sql`
   8. `deletion-log-migration.sql`
   9. `installation-tasks-migration.sql`
3. Get your project URL and anon key from Settings → API
4. Update `db.js` with your project URL and anon key (or use a `config.js` file — see commented section in `index.html`)

## File overview

| File | Purpose |
|---|---|
| `index.html` | App entry, loads scripts + CDN libs |
| `manifest.json` | PWA install metadata |
| `sw.js` | Service worker (offline shell caching) |
| `icon.svg` | App icon (used by manifest + favicon) |
| `app.js` | Main application logic (~6900 lines) |
| `db.js` | Supabase client + data layer (CRUD + realtime) |
| `styles.css` | All styling |
| `*-migration.sql` | Database schema (run once in Supabase) |

## Default credentials

- Admin: `admin` / `password1`
- Akash (field worker): `akash` / `akash`

Change these in `app.js` (search for `currentUser`).

## Tech stack

- Vanilla HTML/CSS/JS — no build pipeline
- Supabase (Postgres + realtime + auth bypass via anon key)
- SheetJS (xlsx) — Excel I/O
- html5-qrcode — Camera barcode scanning

## Browser support

- Chrome / Edge / Safari (mobile + desktop)
- HTTPS required for camera (GitHub Pages provides this)

---

Built with Claude. Hinglish UI + comments.
