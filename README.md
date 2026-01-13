# EduFair Lead Scanner

A complete lead retrieval system for education fairs. Enables 30+ universities to digitally collect leads from 3000+ attendees using their smartphones.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         REGISTRATION PHASE                          │
├─────────────────────────────────────────────────────────────────────┤
│  User → CF7 Form → PHP generates UUID → Google Sheet + Email w/ QR  │
└─────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────┐
│                           EVENT DAY                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Volunteer opens ?uni=HARVARD → Scans QR → localStorage → Sheet     │
└─────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────┐
│                          POST-EVENT                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Download CSVs → Run Python script → leads_HARVARD.csv per uni      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
edufair-lead-scanner/
├── index.html                    # Scanner PWA (deploy to GitHub Pages)
├── Code.gs                       # Google Apps Script (deploy as Web App)
├── wordpress/
│   └── ticket-id-generator.php   # CF7 UUID generation snippet
├── email-templates/
│   └── confirmation-email.html   # Email template with QR code
├── scripts/
│   └── process_leads.py          # Post-event lead splitting
├── requirements.txt              # Python dependencies
└── .gitignore
```

---

## Setup Guide

### Phase 1: Registration System (WordPress)

#### 1.1 Add Hidden Field to CF7 Form
```
[hidden ticket_id id:ticket_id default:get]
```

#### 1.2 Install the UUID Generator
Copy `wordpress/ticket-id-generator.php` into:
- **WPCode plugin** (recommended), OR
- Your theme's `functions.php`

#### 1.3 Map to Google Sheet
Ensure your CF7-to-Sheet connector includes the `ticket_id` field.

Your sheet should have these columns:
| Name | Email | Phone | ... | ticket_id |
|------|-------|-------|-----|-----------|

#### 1.4 Configure Confirmation Email
In your email automation (n8n, CF7 Mail, etc.), use this QR code snippet:

```html
<img src="https://quickchart.io/qr?text=[ticket_id]&size=250" alt="QR" />
```

See `email-templates/confirmation-email.html` for a full template.

---

### Phase 2: Scanner App (Event Day)

#### 2.1 Deploy Google Apps Script

1. Open your Google Sheet
2. **Extensions → Apps Script**
3. Paste contents of `Code.gs`
4. **Deploy → New deployment → Web App**
   - Execute as: Me
   - Access: Anyone
5. Copy the Web App URL

#### 2.2 Configure the Scanner

1. Open `index.html`
2. Line ~239: Paste your Web App URL
3. Commit and push to GitHub
4. Enable GitHub Pages (Settings → Pages → main branch)

#### 2.3 Create University Links

| University | URL |
|------------|-----|
| Harvard | `https://yoursite.github.io/edufair-lead-scanner/?uni=HARVARD` |
| Yale | `https://yoursite.github.io/edufair-lead-scanner/?uni=YALE` |
| MIT | `https://yoursite.github.io/edufair-lead-scanner/?uni=MIT` |

---

### Phase 3: Post-Event Processing

#### 3.1 Export Data

1. From your Registration Sheet → Download as `registrations.csv`
2. From `Raw_Scans` tab → Download as `raw_scans.csv`

#### 3.2 Run the Script

```bash
# Install dependencies
pip install -r requirements.txt

# Process leads
python scripts/process_leads.py
```

#### 3.3 Output

```
reports/
├── leads_HARVARD.csv
├── leads_YALE.csv
├── leads_MIT.csv
└── ...
```

---

## Testing

See [TESTING.md](TESTING.md) for:
- Automated test results
- Manual testing steps
- Troubleshooting guide

---

## Key Features

- **Offline-First**: Scans saved to device, sync when online
- **Concurrent-Safe**: LockService handles 30+ simultaneous writers
- **Zero Server Cost**: GitHub Pages + Google Sheets
- **Dynamic QR**: No image storage, QuickChart renders on-the-fly
