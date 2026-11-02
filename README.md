# Client Tracker

A focused planner for personal training businesses:

- In-person clients with banked session rules:
  - max 4 active banked sessions per client
  - each banked session expires after 3 months
- Online clients with monthly call due tracking
- Client archive flow (restore or permanent delete)
- Built-in data protection:
  - continuous local autosave
  - manual export/import backup
  - optional Supabase cloud sync with login
  - daily cloud restore points
  - save status indicators (local/cloud/offline)

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start dev server:

```bash
npm run dev
```

3. Open:

http://localhost:5173

## Data safety modes

### 1) Local-only (works immediately)

The app autosaves in browser storage and keeps local snapshots.

Also available in the UI:

- Export backup (JSON file)
- Import backup (restore from JSON file)

Recommended habit:

- Export a backup once a week to iCloud Drive or Google Drive.

### 2) Cloud sync with Supabase (recommended)

This protects against device loss and browser-data clearing.

#### Step A: Create env file

Copy .env.example to .env and set:

```bash
VITE_SUPABASE_URL=your_project_url
VITE_SUPABASE_ANON_KEY=your_anon_key
VITE_OWNER_EMAIL=owner_email_for_single_account_lock_optional
```

#### Step B: Create table and policies

Run SQL from:

supabase/schema.sql

in your Supabase SQL editor.

#### Step C: Use cloud login in app

In the Data safety and cloud sync panel:

- Recommended: Password login tab
  - Create account once with email + strong password
  - Sign in with password on normal days (no email required)
  - Use "Forgot password" to send reset link
- Optional fallback: Magic link tab
  - Use only when needed (rate-limited if requested too often)

After sign-in, app state is auto-saved to cloud and can be pulled to recover.

### Restore points

- The app keeps the latest cloud copy and also stores daily restore points.
- In "Login and backups", choose a restore point and use "Restore selected backup" to roll back if needed.

### Recommended daily use for one business owner

- Use one account email for all real business data (your girlfriend's email).
- Keep that account signed in on her working device.
- Use Export backup weekly to cloud storage (iCloud Drive/Google Drive) as an extra recovery layer.

## Recovery checklist

If data is missing on a device:

1. Sign in via cloud panel and pull latest cloud copy.
2. If needed, import latest exported JSON backup.
3. If cloud is unavailable, restore from local backup JSON export archive.

## Workflow speed tools

- Quick bank today: choose a client and bank today's session in one click.
- Bulk add in-person clients: paste names (one per line) and add all at once.

## Build

```bash
npm run build
```
