/**
 * EduFair Lead Receiver - Google Apps Script
 * 
 * This script receives scan data from the PWA and appends it to the active sheet.
 * Deploy as: Web App | Execute as: Me | Access: Anyone
 * 
 * IMPORTANT: After updating this code, you MUST create a NEW deployment
 * (Deploy -> New Deployment), not just save. Then update the URL in index.html.
 */

/**
 * Handle GET requests (browser redirects often convert POST to GET)
 */
function doGet(e) {
  return handleRequest(e, 'GET');
}

/**
 * Handle POST requests
 */
function doPost(e) {
  return handleRequest(e, 'POST');
}

/**
 * Unified request handler for both GET and POST
 */
function handleRequest(e, method) {
  const lock = LockService.getScriptLock();
  
  try {
    lock.waitLock(10000);
  } catch (err) {
    return createResponse({ result: 'error', message: 'Server busy' });
  }

  try {
    let data = null;

    // Parse data based on request type
    if (method === 'POST' && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else if (e.parameter && e.parameter.data) {
      // Handle data passed as URL parameter
      data = JSON.parse(e.parameter.data);
    } else if (e.parameter && e.parameter.uni && e.parameter.uuid) {
      // Handle individual URL parameters
      data = {
        uni: e.parameter.uni,
        uuid: e.parameter.uuid,
        timestamp: e.parameter.timestamp || new Date().toISOString()
      };
    }

    // Validate
    if (!data || !data.uni || !data.uuid) {
      return createResponse({ 
        result: 'error', 
        message: 'Missing data. Required: uni, uuid',
        received: e.parameter || 'none'
      });
    }

    // Get or create sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('Raw_Scans');
    
    if (!sheet) {
      sheet = ss.insertSheet('Raw_Scans');
      sheet.appendRow(['Timestamp', 'Uni_ID', 'UUID']);
      sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    }

    // Append data
    const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();
    sheet.appendRow([timestamp, data.uni, data.uuid]);

    return createResponse({ result: 'success', row: sheet.getLastRow() });

  } catch (err) {
    return createResponse({ result: 'error', message: err.toString() });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Create a properly formatted response
 */
function createResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run once to create the Raw_Scans sheet
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Raw_Scans');
  
  if (!sheet) {
    sheet = ss.insertSheet('Raw_Scans');
    sheet.appendRow(['Timestamp', 'Uni_ID', 'UUID']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    Logger.log('Created Raw_Scans sheet');
  } else {
    Logger.log('Raw_Scans sheet exists');
  }
}
