/**
 * Organizer-only participant link administration.
 *
 * This file belongs in the same Apps Script project as Code.gs. These
 * functions are run manually from the editor; they are not HTTP routes.
 */

const SCANNER_BASE_URL = 'https://givi-guntsadze.github.io/edufair-lead-scanner/';
const MAX_PARTICIPANT_NAME_LENGTH = 150;

/**
 * Generate credentials only for rows that have a name and ID but no existing
 * token hash or URL. Existing distributed links are never changed implicitly.
 */
function generateParticipantUrls() {
  validateHttpsScannerBaseUrl(SCANNER_BASE_URL);
  const sheet = requireParticipantAdminSheet();
  const rows = getParticipantRows(sheet);

  rows.forEach(function(row) {
    if (!isBlankParticipantRow(row)) {
      validateParticipantAdminRow(row);
    }
  });
  assertUniqueParticipantIds(rows);

  let generated = 0;
  let skipped = 0;

  rows.forEach(function(row) {
    if (isBlankParticipantRow(row)) {
      return;
    }

    if (row.tokenHash && row.scannerUrl) {
      skipped += 1;
      return;
    }

    writeParticipantCredential(
      sheet,
      row.rowNumber,
      createParticipantCredential(row.participantId)
    );
    generated += 1;
  });

  return { generated: generated, skipped: skipped };
}

/**
 * Rotate exactly one selected participant row. This explicit action
 * invalidates the previously distributed link and reactivates the new one.
 */
function rotateSelectedParticipantUrl() {
  validateHttpsScannerBaseUrl(SCANNER_BASE_URL);
  const sheet = requireParticipantAdminSheet();
  const range = SpreadsheetApp.getActiveRange();

  if (!range || range.getRow() < 2 || range.getNumRows() !== 1) {
    throw new Error('Select exactly one participant data row before rotating its URL.');
  }

  if (range.getSheet().getName() !== SCAN_SHEETS.PARTICIPANTS) {
    throw new Error('Select a row in participant_url before rotating its URL.');
  }

  const row = readParticipantRow(sheet, range.getRow());
  validateParticipantIdentity(row);
  assertUniqueParticipantIds(getParticipantRows(sheet));

  writeParticipantCredential(
    sheet,
    row.rowNumber,
    createParticipantCredential(row.participantId)
  );

  return { participantId: row.participantId };
}

function requireParticipantAdminSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return requireSheetWithHeaders(
    spreadsheet,
    SCAN_SHEETS.PARTICIPANTS,
    SCAN_HEADERS.PARTICIPANTS
  );
}

function getParticipantRows(sheet) {
  return readDataRows(sheet, SCAN_HEADERS.PARTICIPANTS.length)
    .map(function(values, index) {
      return participantRowFromValues(values, index + 2);
    });
}

function readParticipantRow(sheet, rowNumber) {
  const values = sheet
    .getRange(rowNumber, 1, 1, SCAN_HEADERS.PARTICIPANTS.length)
    .getValues()[0];
  return participantRowFromValues(values, rowNumber);
}

function participantRowFromValues(values, rowNumber) {
  return {
    rowNumber: rowNumber,
    participantName: values[0],
    participantId: values[1],
    tokenHash: values[2],
    active: values[3],
    scannerUrl: values[4]
  };
}

function isBlankParticipantRow(row) {
  return [
    row.participantName,
    row.participantId,
    row.tokenHash,
    row.active,
    row.scannerUrl
  ].every(function(value) {
    return value === '' || value === null;
  });
}

function validateParticipantAdminRow(row) {
  validateParticipantIdentity(row);

  const hasHash = typeof row.tokenHash === 'string' && row.tokenHash.length > 0;
  const hasUrl = typeof row.scannerUrl === 'string' && row.scannerUrl.length > 0;

  if (hasHash !== hasUrl) {
    throw new Error(
      'Row ' + row.rowNumber + ' has an incomplete existing credential.'
    );
  }

  if (!hasHash) {
    if (row.active !== '' && row.active !== null) {
      throw new Error(
        'Row ' + row.rowNumber + ' has Active set without an existing credential.'
      );
    }
    return;
  }

  if (!TOKEN_PATTERN.test(row.tokenHash)) {
    throw new Error('Invalid Token_Hash on row ' + row.rowNumber + '.');
  }
  if (!isBooleanValue(row.active)) {
    throw new Error('Invalid Active value on row ' + row.rowNumber + '.');
  }

  const rawToken = extractTokenFromParticipantUrl(
    row.scannerUrl,
    row.participantId
  );
  if (!rawToken || !constantTimeEqual(hashToken(rawToken), row.tokenHash)) {
    throw new Error('Scanner_URL does not match Token_Hash on row ' + row.rowNumber + '.');
  }
}

function validateParticipantIdentity(row) {
  if (!isValidParticipantName(row.participantName)) {
    throw new Error('Invalid Participant_Name on row ' + row.rowNumber + '.');
  }
  if (!isValidParticipantId(row.participantId)) {
    throw new Error('Invalid Participant_ID on row ' + row.rowNumber + '.');
  }
}

function isValidParticipantName(value) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_PARTICIPANT_NAME_LENGTH &&
    value.trim() === value &&
    !hasSpreadsheetFormulaPrefix(value) &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function isBooleanValue(value) {
  return value === true || value === false ||
    (typeof value === 'string' && /^(TRUE|FALSE)$/i.test(value.trim()));
}

function assertUniqueParticipantIds(rows) {
  const seen = Object.create(null);
  rows.forEach(function(row) {
    if (isBlankParticipantRow(row)) {
      return;
    }
    const key = row.participantId;
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      throw new Error('Duplicate Participant_ID: ' + key);
    }
    seen[key] = true;
  });
}

function createParticipantCredential(participantId) {
  const token = generateParticipantToken();
  return {
    tokenHash: hashToken(token),
    active: true,
    scannerUrl: buildParticipantUrl(participantId, token)
  };
}

function generateParticipantToken() {
  const token = (Utilities.getUuid() + Utilities.getUuid())
    .replace(/-/g, '')
    .toLowerCase();

  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('Unable to generate a valid participant token.');
  }
  return token;
}

function buildParticipantUrl(participantId, token) {
  validateHttpsScannerBaseUrl(SCANNER_BASE_URL);
  return SCANNER_BASE_URL +
    '?uni=' + encodeURIComponent(participantId) +
    '#token=' + encodeURIComponent(token);
}

function extractTokenFromParticipantUrl(scannerUrl, participantId) {
  const prefix = SCANNER_BASE_URL +
    '?uni=' + encodeURIComponent(participantId) +
    '#token=';

  if (typeof scannerUrl !== 'string' || scannerUrl.indexOf(prefix) !== 0) {
    return null;
  }

  try {
    const token = decodeURIComponent(scannerUrl.slice(prefix.length));
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch (error) {
    return null;
  }
}

function writeParticipantCredential(sheet, rowNumber, credential) {
  sheet.getRange(rowNumber, 3, 1, 3).setValues([[
    credential.tokenHash,
    credential.active,
    credential.scannerUrl
  ]]);
}

function validateHttpsScannerBaseUrl(value) {
  if (typeof value !== 'string' ||
      !/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?\/$/.test(value)) {
    throw new Error('SCANNER_BASE_URL must be an HTTPS URL ending in /.');
  }
  return value;
}
