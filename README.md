# EduFair Live Scanner

A lightweight, offline-first PWA for capturing event leads via QR code scanning.

## How It Works

1. **Attendees** have a QR code (from their confirmation email) containing their unique ID.
2. **University volunteers** open the scanner app on their phones.
3. **Scans are saved locally** first (works offline), then synced to Google Sheets.

---

## Setup Instructions

### Step 1: Deploy the Backend (Google Apps Script)

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.
2. Name it something like `EduFair_Raw_Scans`.
3. Go to **Extensions → Apps Script**.
4. Delete any existing code and paste the contents of `Code.gs`.
5. Click **Run → setup** (first time only, to create the sheet).
6. Click **Deploy → New deployment**.
7. Configure:
   - **Type**: Web app
   - **Execute as**: Me
   - **Who has access**: Anyone
8. Click **Deploy** and copy the Web App URL.

### Step 2: Configure the Frontend

1. Open `index.html` in a text editor.
2. Find line ~147:
   ```javascript
   const API_URL = "YOUR_GOOGLE_SCRIPT_WEB_APP_URL_HERE";
   ```
3. Replace the placeholder with your Web App URL from Step 1.
4. Save the file.

### Step 3: Host the App

**Option A: GitHub Pages (Recommended)**
1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Set Source to `main` branch, `/ (root)` folder.
4. Your app will be live at `https://yourusername.github.io/repo-name/`

**Option B: Any Static Host**
- Simply upload `index.html` to Netlify, Vercel, or any web server.

---

## Usage

### Creating Scanner Links for Each University

Each university gets their own URL with a `?uni=` parameter:

| University | Scanner URL |
|------------|-------------|
| Harvard    | `https://yoursite.com/?uni=HARVARD` |
| Yale       | `https://yoursite.com/?uni=YALE` |
| MIT        | `https://yoursite.com/?uni=MIT` |

**Tip**: Generate QR codes for these URLs so volunteers can quickly open the scanner.

### Scanning Flow

1. Volunteer opens their university's scanner link.
2. Points camera at attendee's QR badge.
3. Screen flashes **green** → "Saved!"
4. Data syncs to Google Sheets automatically.

### Offline Mode

- If Wi-Fi is down, scans are stored locally on the device.
- A yellow counter shows "X pending uploads".
- When connection returns, data syncs automatically.
- You can also tap "Sync Now" to force a retry.

---

## Data Output

Your Google Sheet (`Raw_Scans` tab) will contain:

| Timestamp | Uni_ID | UUID |
|-----------|--------|------|
| 2026-01-13 10:45:00 | HARVARD | A1B2-C3D4 |
| 2026-01-13 10:46:12 | HARVARD | E5F6-G7H8 |
| 2026-01-13 10:47:05 | YALE | A1B2-C3D4 |

This raw data can later be joined with your registration database to get full attendee details.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Configuration Error" on load | Add `?uni=NAME` to the URL |
| Camera not working | Check browser permissions, use HTTPS |
| Scans stuck as "pending" | Check your API_URL, verify Web App is deployed |
| Duplicate scans ignored | This is intentional—same UUID won't be added twice |
