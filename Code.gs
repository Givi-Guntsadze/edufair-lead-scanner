/**
 * @OnlyCurrentDoc
 */

/**
 * EduFair Lead Receiver - Google Apps Script
 *
 * Bind this project only to the private, PII-free fair-scan-file workbook.
 * Deploy as: Web App | Execute as: Me | Access: Anyone
 */

const SCAN_SHEETS = Object.freeze({
  RAW_SCANS: 'Raw_Scans',
  PARTICIPANTS: 'participant_url',
  VALID_TICKETS: 'valid_tickets'
});

const SCAN_HEADERS = Object.freeze({
  RAW_SCANS: ['Timestamp', 'Uni_ID', 'UUID'],
  PARTICIPANTS: [
    'Participant_Name',
    'Participant_ID',
    'Token_Hash',
    'Active',
    'Scanner_URL'
  ],
  VALID_TICKETS: ['UUID']
});

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TICKET_ID_PATTERN = /^[A-Z0-9]{8}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PARTICIPANT_ID_LENGTH = 50;

/**
 * GET is deliberately non-mutating. Scan credentials belong in a POST body,
 * not in URLs that can be retained by logs or browser history.
 */
function doGet() {
  return createResponse({ result: 'error', code: 'method_not_allowed' });
}

/**
 * Receive one queued scan from the static scanner.
 */
function doPost(e) {
  return handleScanRequest(e);
}

function handleScanRequest(e) {
  const data = parsePostParameters(e);

  if (!isValidParticipantId(data.participant_id) ||
      !TOKEN_PATTERN.test(data.token || '') ||
      !isValidTicketId(data.uuid) ||
      !isValidTimestamp(data.timestamp)) {
    return createResponse({ result: 'error', code: 'invalid_request' });
  }

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const participantSheet = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.PARTICIPANTS,
      SCAN_HEADERS.PARTICIPANTS
    );
    const ticketSheet = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.VALID_TICKETS,
      SCAN_HEADERS.VALID_TICKETS
    );
    const rawScanSheet = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.RAW_SCANS,
      SCAN_HEADERS.RAW_SCANS
    );

    const participant = findActiveParticipant(
      participantSheet,
      hashToken(data.token)
    );

    // The token is authoritative. The public ID is checked only to detect a
    // modified or accidentally mismatched participant link.
    if (!participant || participant.id !== data.participant_id) {
      return createResponse({ result: 'error', code: 'unauthorized' });
    }

    if (!ticketExists(ticketSheet, data.uuid)) {
      return createResponse({ result: 'error', code: 'invalid_ticket' });
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (error) {
      return createResponse({ result: 'error', code: 'server_busy' });
    }

    try {
      if (scanExists(rawScanSheet, participant.id, data.uuid)) {
        return createResponse({ result: 'success', duplicate: true });
      }

      rawScanSheet.appendRow([
        new Date(data.timestamp),
        neutralizeFormula(participant.id),
        neutralizeFormula(data.uuid)
      ]);

      return createResponse({ result: 'success', duplicate: false });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    // Keep diagnostic details in the Apps Script execution log only. Public
    // responses must not expose sheet names, rows, tokens, or stack traces.
    console.error('Scan receiver error: ' + String(error));
    return createResponse({ result: 'error', code: 'server_error' });
  }
}

function parsePostParameters(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  return {
    participant_id: parameters.participant_id,
    token: parameters.token,
    uuid: parameters.uuid,
    timestamp: parameters.timestamp
  };
}

function requireSheetWithHeaders(spreadsheet, sheetName, requiredHeaders) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Missing required scanner sheet: ' + sheetName);
  }

  const headers = sheet
    .getRange(1, 1, 1, requiredHeaders.length)
    .getValues()[0];

  const validHeaders = requiredHeaders.every(function(requiredHeader, index) {
    return headers[index] === requiredHeader;
  });

  if (!validHeaders) {
    throw new Error('Invalid headers in scanner sheet: ' + sheetName);
  }

  return sheet;
}

function findActiveParticipant(sheet, tokenHash) {
  const rows = readDataRows(sheet, SCAN_HEADERS.PARTICIPANTS.length);
  const matchingRows = rows.filter(function(row) {
    return typeof row[2] === 'string' &&
      constantTimeEqual(row[2].toLowerCase(), tokenHash);
  });

  if (matchingRows.length > 1) {
    throw new Error('Duplicate participant token hash');
  }

  if (matchingRows.length === 0 || !isActiveValue(matchingRows[0][3])) {
    return null;
  }

  const participantId = matchingRows[0][1];
  if (!isValidParticipantId(participantId)) {
    throw new Error('Invalid configured participant ID');
  }

  return { id: participantId };
}

function ticketExists(sheet, uuid) {
  return readDataRows(sheet, SCAN_HEADERS.VALID_TICKETS.length)
    .some(function(row) {
      return String(row[0]).trim().toUpperCase() === uuid;
    });
}

function scanExists(sheet, participantId, uuid) {
  return readDataRows(sheet, SCAN_HEADERS.RAW_SCANS.length)
    .some(function(row) {
      return String(row[1]) === participantId &&
        String(row[2]).trim().toUpperCase() === uuid;
    });
}

function readDataRows(sheet, width) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  return sheet.getRange(2, 1, lastRow - 1, width).getValues();
}

function isActiveValue(value) {
  return value === true ||
    (typeof value === 'string' && value.trim().toUpperCase() === 'TRUE');
}

function hashToken(token) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    token,
    Utilities.Charset.UTF_8
  );

  return digest.map(function(byte) {
    return ((byte + 256) % 256).toString(16).padStart(2, '0');
  }).join('');
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index % left.length) || 0) ^
      (right.charCodeAt(index % right.length) || 0);
  }
  return difference === 0;
}

function hasSpreadsheetFormulaPrefix(value) {
  return typeof value === 'string' &&
    /^'*[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/.test(value);
}

function isValidParticipantId(value) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_PARTICIPANT_ID_LENGTH &&
    value.trim() === value &&
    !hasSpreadsheetFormulaPrefix(value) &&
    !/[\u0000-\u001F\u007F<>:"\\|?*]/.test(value);
}

// Retain the old helper name for callers that used the previous custom-ID API.
function isValidUniversityId(value) {
  return isValidParticipantId(value);
}

function isValidTicketId(value) {
  return typeof value === 'string' && TICKET_ID_PATTERN.test(value);
}

function isValidTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function neutralizeFormula(value) {
  return hasSpreadsheetFormulaPrefix(value) ? "'" + value : value;
}

function createResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run manually once after binding this project to fair-scan-file. Missing tabs
 * are created, but existing non-empty tabs are never overwritten or repaired.
 */
function setup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ensureAdministrativeSheet(
    spreadsheet,
    SCAN_SHEETS.RAW_SCANS,
    SCAN_HEADERS.RAW_SCANS
  );
  ensureAdministrativeSheet(
    spreadsheet,
    SCAN_SHEETS.PARTICIPANTS,
    SCAN_HEADERS.PARTICIPANTS
  );
  ensureAdministrativeSheet(
    spreadsheet,
    SCAN_SHEETS.VALID_TICKETS,
    SCAN_HEADERS.VALID_TICKETS
  );
}

function ensureAdministrativeSheet(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }

  return requireSheetWithHeaders(spreadsheet, sheetName, headers);
}
