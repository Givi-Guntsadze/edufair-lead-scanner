/**
 * EduFair Lead Receiver - Google Apps Script
 * 
 * This script receives scan data from the PWA and appends it to the active sheet.
 * Deploy as: Web App | Execute as: Me | Access: Anyone
 */

function doPost(e) {
  // Use lock to handle concurrent requests from multiple scanners
  const lock = LockService.getScriptLock();
  
  try {
    // Wait up to 10 seconds for lock (handles 30+ simultaneous scanners)
    lock.waitLock(10000);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', message: 'Server busy, please retry' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    // Parse incoming data
    const data = JSON.parse(e.postData.contents);
    
    // Validate required fields
    if (!data.uni || !data.uuid) {
      return ContentService
        .createTextOutput(JSON.stringify({ result: 'error', message: 'Missing uni or uuid' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Get or create the Raw_Scans sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Raw_Scans');
    
    if (!sheet) {
      sheet = ss.insertSheet('Raw_Scans');
      sheet.appendRow(['Timestamp', 'Uni_ID', 'UUID']);
      sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    }

    // Append the scan data
    const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();
    sheet.appendRow([timestamp, data.uni, data.uuid]);

    return ContentService
      .createTextOutput(JSON.stringify({ result: 'success', row: sheet.getLastRow() }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Optional: Run this once to create the Raw_Scans sheet with headers
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Raw_Scans');
  
  if (!sheet) {
    sheet = ss.insertSheet('Raw_Scans');
    sheet.appendRow(['Timestamp', 'Uni_ID', 'UUID']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    Logger.log('Created Raw_Scans sheet with headers');
  } else {
    Logger.log('Raw_Scans sheet already exists');
  }
}
