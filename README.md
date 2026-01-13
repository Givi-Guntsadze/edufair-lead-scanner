# EduFair Scan System 🎓

A serverless, offline-first lead retrieval system for university fairs.

## Components

1.  **Scanner App (`index.html`)**: PWA for scanning QR codes. Works offline.
2.  **Backend API (`Code.gs`)**: Google Apps Script to receive data and save to Google Sheets.
3.  **Data Processor (`process_leads.py`)**: Python script to merge scan data with registration data.

## 🚀 Setup Guide

### 1. Backend Deployment (Google Apps Script)

1.  Create a new **Google Sheet**.
2.  Go to **Extensions** > **Apps Script**.
3.  Clear the default code and paste the content of `Code.gs`.
4.  Click **Save** (floppy disk icon).
5.  Click **Run** on the `setup` function to initialize the "Raw_Scans" sheet. (Grant permissions when asked).
6.  Click **Deploy** > **New Demployment**.
7.  Click the **Select type** gear icon > **Web App**.
8.  **Configuration**:
    *   **Description**: EduFair API
    *   **Execute as**: Me (your email)
    *   **Who has access**: **Anyone** (Required for the frontend to post without auth hurdles).
9.  Click **Deploy**.
10. Copy the **Web App URL** (ends in `/exec`).

### 2. Frontend Configuration

1.  Open `index.html` in a text editor.
2.  Find the line:
    ```javascript
    const GOOGLE_SCRIPT_URL = 'REPLACE_ME_WITH_DEPLOYED_WEB_APP_URL';
    ```
3.  Replace the placeholder with your copied Web App URL.
4.  Save the file.

### 3. Running the App

*   **Locally**: Open `index.html` in Chrome/Edge.
*   **Hosting**: Upload `index.html` to GitHub Pages, Netlify, or any static host.
*   **PWA**: Users can "Add to Home Screen" for a full-screen experience.

### 4. Data Processing

1.  Download the "Raw_Scans" sheet as `scans.csv`.
2.  Ensure you have `registrations.csv` (headers: `UUID`, `Name`, `University`, etc.).
3.  Run the script:
    ```bash
    pip install pandas
    python process_leads.py
    ```
4.  Collect the generated `export_{University}.csv` files.

## ⚠️ Notes

*   **Offline Mode**: The app saves scans to `localStorage`. When back online, click "Sync Pending" (or it auto-syncs on network status change).
*   **CORS**: The GAS Web App "Anyone" access mode allows simple POST requests. The frontend logic handles the opaque response.
