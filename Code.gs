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
  RAW_SCANS: ['Timestamp', 'Uni_ID', 'UUID', 'Campus'],
  PARTICIPANTS: [
    'Participant_Name',
    'Participant_ID',
    'Token_Hash',
    'Active',
    'Scanner_URL'
  ],
  VALID_TICKETS: ['UUID']
});

// CAMPUS_CONFIG:BEGIN — keep in sync with the copy in index.html. Both
// copies are asserted identical by tests/campus_config_test.js. Only
// institutions verified against the current campus reference workbook and
// an existing participant_url Participant_ID are listed here. Adding a
// future institution should only require one more `participantId: [...]`
// entry ending in 'Undecided'.
const CAMPUS_CONFIG = Object.freeze({
  sommet: ['Glion', 'Les Roches', 'Ecole Ducasse', 'Invictus Education', 'Indian School of Hospitality', 'Undecided'],
  audencia: ['Paris', 'Nantes', 'Undecided'],
  ied: ['Milan', 'Rome', 'Florence', 'Turin', 'Accademia Aldo Galli - Como', 'Madrid', 'Barcelona', 'Bilbao', 'Undecided'],
  ieu: ['Madrid', 'Segovia', 'Undecided'],
  nicosia: ['Nicosia', 'Athens', 'Undecided'],
  seg: ['SHMS', 'Cesar Ritz', 'HIM Business School', 'Culinary Arts Academy', 'Undecided'],
  ucam: ['Murcia', 'online', 'Undecided'],
  gbsb: ['Barcelona', 'Madrid', 'Malta', 'Online', 'Undecided'],
  skema: ['Lille', 'Paris', 'Sophia Antipolis', 'Brazil', 'Canada', 'China', 'South Africa', 'UAE', 'USA', 'Undecided'],
  eubschool: ['Barcelona', 'Geneva', 'Munich', 'Undecided'],
  xamk: ['Kouvola', 'Kotka', 'Mikkeli', 'Savonlinna', 'Undecided'],
  bsbi: ['Berlin', 'Hamburg', 'Barcelona', 'Madrid', 'Paris', 'Undecided'],
  campspain: ['Vigo', 'Madrid', 'Undecided'],
  into: ['US', 'UK', 'Australia', 'Spain', 'UAE', 'Undecided'],
  gedu: ['US', 'UK', 'Ireland', 'UAE', 'Australia', 'Germany', 'Malta', 'France', 'Spain', 'Undecided'],
  burgsb: ['Dijon', 'Lyon', 'Undecided']
});
// CAMPUS_CONFIG:END

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TICKET_ID_PATTERN = /^[A-Z0-9]{8}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PARTICIPANT_ID_LENGTH = 50;
const SCAN_SPREADSHEET_ID_PROPERTY = 'SCAN_SPREADSHEET_ID';
const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

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
    logDiagnostic('warn', 'scan_rejected', 'invalid_request', data);
    return createResponse({ result: 'error', code: 'invalid_request' });
  }

  try {
    const spreadsheet = getConfiguredScanSpreadsheet();
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
      logDiagnostic('warn', 'scan_rejected', 'unauthorized', data);
      return createResponse({ result: 'error', code: 'unauthorized' });
    }

    // Campus is optional protocol metadata. Validate it only against the
    // authenticated participant's own configured allowlist so an arbitrary
    // or mismatched value can never reach Raw_Scans.
    if (!isValidCampusValue(participant.id, data.campus)) {
      logDiagnostic('warn', 'scan_rejected', 'invalid_campus', data, participant);
      return createResponse({ result: 'error', code: 'invalid_campus' });
    }

    if (!ticketExists(ticketSheet, data.uuid)) {
      logDiagnostic('warn', 'scan_rejected', 'invalid_ticket', data, participant);
      return createResponse({ result: 'error', code: 'invalid_ticket' });
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (error) {
      logDiagnostic('warn', 'scan_rejected', 'server_busy', data, participant);
      return createResponse({ result: 'error', code: 'server_busy' });
    }

    try {
      if (scanExists(rawScanSheet, participant.id, data.uuid)) {
        logDiagnostic('log', 'scan_duplicate', 'success', data, participant);
        return createResponse({ result: 'success', duplicate: true });
      }

      rawScanSheet.appendRow([
        new Date(data.timestamp),
        neutralizeFormula(participant.id),
        neutralizeFormula(data.uuid),
        (typeof data.campus === 'string' && data.campus !== '')
          ? neutralizeFormula(data.campus)
          : ''
      ]);
      SpreadsheetApp.flush();

      return createResponse({ result: 'success', duplicate: false });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    // Keep diagnostic details in the Apps Script execution log only. Public
    // responses must not expose sheet names, rows, tokens, or stack traces.
    logDiagnostic('error', 'scan_error', 'server_error', data, null, String(error));
    return createResponse({ result: 'error', code: 'server_error' });
  }
}

/**
 * Structured Executions logging for every scan outcome. Only non-sensitive
 * protocol fields are ever included: participant ID, UUID, campus, and the
 * outcome code/event. Never pass the token, its hash, a Scanner_URL, or any
 * registration PII into this function.
 */
function logDiagnostic(level, event, code, data, participant, message) {
  const payload = {
    event: event,
    code: code
  };

  const participantId = (participant && participant.id) || (data && data.participant_id);
  if (typeof participantId !== 'undefined') {
    payload.participantId = participantId;
  }
  if (data && typeof data.uuid !== 'undefined') {
    payload.uuid = data.uuid;
  }
  if (data && typeof data.campus === 'string' && data.campus !== '') {
    payload.campus = data.campus;
  }
  if (typeof message === 'string') {
    payload.message = message;
  }

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function getConfiguredScanSpreadsheet() {
  const spreadsheetId = PropertiesService
    .getScriptProperties()
    .getProperty(SCAN_SPREADSHEET_ID_PROPERTY);

  if (!SPREADSHEET_ID_PATTERN.test(spreadsheetId || '')) {
    throw new Error('Scanner workbook is not configured. Run setup first.');
  }

  // Bound-script active-file methods are unavailable in web-app executions.
  // The organizer-run setup function records only fair-scan-file's ID.
  return SpreadsheetApp.openById(spreadsheetId);
}

function parsePostParameters(e) {
  const parameters = e && e.parameter ? e.parameter : {};
  return {
    participant_id: parameters.participant_id,
    token: parameters.token,
    uuid: parameters.uuid,
    timestamp: parameters.timestamp,
    campus: parameters.campus
  };
}

/**
 * Campus is optional scan metadata. An absent or empty value is always
 * valid (legacy queue items and non-configured institutions). A supplied
 * value is valid only if it exactly matches one of the authenticated
 * participant's configured options.
 */
function isValidCampusValue(participantId, campus) {
  if (campus === undefined || campus === null || campus === '') {
    return true;
  }
  if (typeof campus !== 'string') {
    return false;
  }
  const configuredCampuses = CAMPUS_CONFIG[participantId];
  return Array.isArray(configuredCampuses) && configuredCampuses.indexOf(campus) !== -1;
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
  if (!spreadsheet) {
    throw new Error('Run setup from the Apps Script project bound to fair-scan-file.');
  }

  const spreadsheetId = spreadsheet.getId();
  if (!SPREADSHEET_ID_PATTERN.test(spreadsheetId || '')) {
    throw new Error('Unable to determine a valid fair-scan-file spreadsheet ID.');
  }

  const scriptProperties = PropertiesService.getScriptProperties();
  const configuredId = scriptProperties.getProperty(SCAN_SPREADSHEET_ID_PROPERTY);
  if (configuredId && configuredId !== spreadsheetId) {
    throw new Error('This Apps Script project is already configured for another workbook.');
  }
  scriptProperties.setProperty(SCAN_SPREADSHEET_ID_PROPERTY, spreadsheetId);

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

/**
 * Run manually, once, from the Apps Script editor before deploying this
 * Campus-aware server version — and only after the current production
 * version is still running normally. Adds only the 'Campus' header to
 * column D of Raw_Scans. It never touches existing headers or rows, and it
 * is idempotent: running it again after the header exists is a no-op.
 */
function migrateRawScansAddCampusColumn() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Run this migration from the Apps Script project bound to fair-scan-file.');
  }

  const sheet = spreadsheet.getSheetByName(SCAN_SHEETS.RAW_SCANS);
  if (!sheet) {
    throw new Error('Missing required scanner sheet: ' + SCAN_SHEETS.RAW_SCANS);
  }

  const legacyHeaders = sheet.getRange(1, 1, 1, 3).getValues()[0];
  const legacyHeadersValid = ['Timestamp', 'Uni_ID', 'UUID'].every(function(header, index) {
    return legacyHeaders[index] === header;
  });
  if (!legacyHeadersValid) {
    throw new Error('Raw_Scans does not have the expected Timestamp, Uni_ID, UUID headers.');
  }

  const campusHeaderCell = sheet.getRange(1, 4, 1, 1);
  const existingCampusHeader = campusHeaderCell.getValue();
  if (existingCampusHeader === 'Campus') {
    return { migrated: false, alreadyPresent: true };
  }
  if (existingCampusHeader !== '') {
    throw new Error('Column D of Raw_Scans is not empty and is not already "Campus".');
  }

  campusHeaderCell.setValue('Campus');
  campusHeaderCell.setFontWeight('bold');
  return { migrated: true, alreadyPresent: false };
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
