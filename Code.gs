function doPost(e) {
  var lock = LockService.getScriptLock();
  // Wait for up to 10 seconds for other processes to finish.
  try {
    lock.waitLock(10000);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({ "result": "error", "message": "Server busy" })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    // Get the sheet
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getSheetByName('Raw_Scans');
    
    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = doc.insertSheet('Raw_Scans');
      sheet.appendRow(['Timestamp', 'UUID', 'Status', 'RawData']); // Header
    }

    // Parse data
    var data = null;
    try {
        if (e.postData && e.postData.contents) {
            data = JSON.parse(e.postData.contents);
        }
    } catch (parseError) {
        // Fallback or just log scanning raw content
    }

    var timestamp = new Date();
    var uuid = data ? data.uuid : 'UNKNOWN';
    var status = data ? data.status : 'raw_post';
    var raw = e.postData ? e.postData.contents : 'no data';

    // Append to sheet
    sheet.appendRow([timestamp, uuid, status, raw]);

    return ContentService.createTextOutput(JSON.stringify({ "result": "success", "row": sheet.getLastRow() })).setMimeType(ContentService.MimeType.JSON);

  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({ "result": "error", "error": e.toString() })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function setup() {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getSheetByName('Raw_Scans');
    if (!sheet) {
      doc.insertSheet('Raw_Scans');
      doc.getSheetByName('Raw_Scans').appendRow(['Timestamp', 'UUID', 'Status', 'RawData']);
    }
}
