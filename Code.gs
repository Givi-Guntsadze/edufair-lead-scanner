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

// --- High-volume synchronization tuning ---
//
// One HTTP request now carries up to this many queued scans. 10 comfortably
// covers "one volunteer scans 5-6 visitors back-to-back" with headroom, while
// keeping the JSON payload and the per-request validation loop small enough
// that a single slow request never represents an unbounded amount of work.
const MAX_BATCH_SIZE = 10;

// The lock now protects only the final write phase (recheck + append), not
// validation or duplicate lookups, so a short wait is enough: a well-behaved
// request holds it for well under a second. A requester that can't get the
// lock in this window returns server_busy immediately rather than making a
// volunteer's device sit on an open connection for up to the previous 10s.
const LOCK_WAIT_MS = 2000;

// Positive-only cache: a UUID is cached only once it has been confirmed
// present in valid_tickets. A cache miss always falls back to a live sheet
// read, so a newly registered ticket is usable on the very next scan
// attempt, not bounded by this TTL. The TTL only controls how long a
// *repeat* lookup of an already-confirmed ticket (e.g. the same visitor
// scanned by a second, third, fourth institution) can skip the sheet
// entirely.
const VALID_TICKET_CACHE_PREFIX = 'vt_';
const VALID_TICKET_CACHE_TTL_SECONDS = 300;

// Participant lookups cache both outcomes (found-and-active, or
// not-found/inactive) because participant_url is small and effectively
// static during an event, unlike valid_tickets. The TTL bounds how long a
// revoked link (Active -> FALSE) or a rotated token can keep working after
// an organizer changes it: up to PARTICIPANT_CACHE_TTL_SECONDS. 60 seconds
// is short enough that a compromised-link revocation is operationally
// meaningful (the organizer is doing this manually, not reacting to a
// live attack in progress) while still avoiding a sheet read on nearly
// every scan from the same device.
const PARTICIPANT_CACHE_PREFIX = 'p_';
const PARTICIPANT_CACHE_TTL_SECONDS = 60;

// Duplicate keys are cached for the CacheService maximum (6 hours), long
// enough to cover a single event day. This cache is populated only at the
// moment a row is actually written (or found already written), so it can
// never cause a false accept: a cache miss always falls back to a real
// Raw_Scans read before anything is treated as non-duplicate.
const DUPLICATE_CACHE_PREFIX = 'dup_';
const DUPLICATE_CACHE_TTL_SECONDS = 21600;

/**
 * GET is deliberately non-mutating. Scan credentials belong in a POST body,
 * not in URLs that can be retained by logs or browser history.
 */
function doGet() {
  return createResponse({ result: 'error', code: 'method_not_allowed' });
}

/**
 * Receive one or more queued scans from the static scanner.
 *
 * Two wire formats are accepted so the frontend and this backend can be
 * redeployed independently without ever silently failing every scan:
 *
 * - New: a JSON body shaped { scans: [{ client_id, participant_id, token,
 *   uuid, timestamp, campus }, ...] }, answered with
 *   { results: [{ client_id, result, code, duplicate }, ...] }.
 * - Legacy: the original single-scan application/x-www-form-urlencoded
 *   body, answered with the original flat { result, code, duplicate }
 *   shape. Preserved for any client still running the pre-batching
 *   frontend.
 */
function doPost(e) {
  return handleScanRequest(e);
}

function handleScanRequest(e) {
  const batchInput = parseBatchInput(e);
  if (batchInput) {
    const batchResults = processScanBatch(batchInput.scans.slice(0, MAX_BATCH_SIZE));
    return createResponse({ results: batchResults });
  }

  const legacyScan = parsePostParameters(e);
  legacyScan.client_id = 'legacy';
  const single = processScanBatch([legacyScan])[0];
  return createResponse({
    result: single.result,
    code: single.code,
    duplicate: single.duplicate
  });
}

/**
 * A JSON batch request is detected by content, not by header, since Apps
 * Script normalizes some content-type handling. Anything that isn't a
 * parseable { scans: [...] } object is treated as the legacy form-encoded
 * protocol instead.
 */
function parseBatchInput(e) {
  const raw = e && e.postData && typeof e.postData.contents === 'string'
    ? e.postData.contents
    : '';
  if (!raw) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return null;
  }

  if (!parsed || !Array.isArray(parsed.scans)) {
    return null;
  }

  return { scans: parsed.scans };
}

function normalizeScanInput(raw) {
  const source = raw || {};
  return {
    clientId: typeof source.client_id === 'string' ? source.client_id : '',
    participantId: source.participant_id,
    token: source.token,
    uuid: source.uuid,
    timestamp: source.timestamp,
    campus: source.campus
  };
}

function toDiagnosticData(item) {
  return {
    participant_id: item.participantId,
    uuid: item.uuid,
    campus: item.campus
  };
}

function errorResult(clientId, code) {
  return { client_id: clientId, result: 'error', code: code };
}

function successResult(clientId, duplicate) {
  return { client_id: clientId, result: 'success', duplicate: duplicate };
}

/**
 * Validate and, where accepted, write a batch of scans as efficiently as
 * possible for high concurrent volume:
 *
 *  1. Per-scan validation (format, participant auth, campus, ticket) runs
 *     entirely before any lock is taken, using caches so repeat lookups
 *     avoid a sheet read.
 *  2. Duplicate detection runs once for the whole batch (one Raw_Scans
 *     read at most, not one per scan), also cache-assisted.
 *  3. The script lock is only acquired if there is something left to
 *     write, is held only for a final cache recheck plus one batched
 *     range write, and is requested with a short timeout so a busy
 *     backend fails fast instead of making every volunteer wait.
 */
function processScanBatch(rawItems) {
  const results = [];

  let spreadsheet;
  let participantSheet;
  let ticketSheet;
  let rawScanSheet;
  try {
    spreadsheet = getConfiguredScanSpreadsheet();
    participantSheet = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.PARTICIPANTS,
      SCAN_HEADERS.PARTICIPANTS
    );
    ticketSheet = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.VALID_TICKETS,
      SCAN_HEADERS.VALID_TICKETS
    );
    rawScanSheet = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.RAW_SCANS,
      SCAN_HEADERS.RAW_SCANS
    );
  } catch (error) {
    for (let i = 0; i < rawItems.length; i += 1) {
      const failedItem = normalizeScanInput(rawItems[i]);
      logDiagnostic('error', 'scan_error', 'server_error', toDiagnosticData(failedItem), null, String(error));
      results.push(errorResult(failedItem.clientId, 'server_error'));
    }
    return results;
  }

  const accepted = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = normalizeScanInput(rawItems[index]);
    const diagnosticData = toDiagnosticData(item);

    if (!isValidParticipantId(item.participantId) ||
        !TOKEN_PATTERN.test(item.token || '') ||
        !isValidTicketId(item.uuid) ||
        !isValidTimestamp(item.timestamp)) {
      logDiagnostic('warn', 'scan_rejected', 'invalid_request', diagnosticData);
      results.push(errorResult(item.clientId, 'invalid_request'));
      continue;
    }

    const participant = findActiveParticipantCached(participantSheet, hashToken(item.token));

    // The token is authoritative. The public ID is checked only to detect a
    // modified or accidentally mismatched participant link.
    if (!participant || participant.id !== item.participantId) {
      logDiagnostic('warn', 'scan_rejected', 'unauthorized', diagnosticData);
      results.push(errorResult(item.clientId, 'unauthorized'));
      continue;
    }

    // Campus is optional protocol metadata. Validate it only against the
    // authenticated participant's own configured allowlist so an arbitrary
    // or mismatched value can never reach Raw_Scans.
    if (!isValidCampusValue(participant.id, item.campus)) {
      logDiagnostic('warn', 'scan_rejected', 'invalid_campus', diagnosticData, participant);
      results.push(errorResult(item.clientId, 'invalid_campus'));
      continue;
    }

    if (!isValidTicketCached(ticketSheet, item.uuid)) {
      logDiagnostic('warn', 'scan_rejected', 'invalid_ticket', diagnosticData, participant);
      results.push(errorResult(item.clientId, 'invalid_ticket'));
      continue;
    }

    accepted.push({
      clientId: item.clientId,
      participantId: participant.id,
      uuid: item.uuid,
      timestamp: item.timestamp,
      campus: item.campus,
      diagnosticData: diagnosticData,
      participant: participant
    });
  }

  if (accepted.length === 0) {
    return results;
  }

  // One duplicate pre-check covers every accepted scan in this batch,
  // instead of one Raw_Scans read per scan.
  const knownDuplicateKeys = loadKnownDuplicateKeys(rawScanSheet, accepted);
  const toWrite = [];
  for (let a = 0; a < accepted.length; a += 1) {
    const candidate = accepted[a];
    const key = duplicateKey(candidate.participantId, candidate.uuid);
    if (knownDuplicateKeys[key]) {
      logDiagnostic('log', 'scan_duplicate', 'success', candidate.diagnosticData, candidate.participant);
      results.push(successResult(candidate.clientId, true));
    } else {
      // De-duplicate within this same batch too: a visitor's badge scanned
      // twice by the same institution in one burst must still produce
      // only one written row.
      knownDuplicateKeys[key] = true;
      toWrite.push(candidate);
    }
  }

  if (toWrite.length === 0) {
    return results;
  }

  const lock = LockService.getScriptLock();
  try {
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (lockError) {
      for (let b = 0; b < toWrite.length; b += 1) {
        logDiagnostic('warn', 'scan_rejected', 'server_busy', toWrite[b].diagnosticData, toWrite[b].participant);
        results.push(errorResult(toWrite[b].clientId, 'server_busy'));
      }
      return results;
    }

    try {
      const rows = [];
      const writtenCandidates = [];
      for (let c = 0; c < toWrite.length; c += 1) {
        const candidate = toWrite[c];
        const key = duplicateKey(candidate.participantId, candidate.uuid);

        // A final, cache-only recheck: any write that completed between
        // our pre-lock snapshot and now must have gone through this same
        // cache-populate step before releasing the lock, so the cache is
        // authoritative here without a second sheet read.
        if (isDuplicateCached(key)) {
          logDiagnostic('log', 'scan_duplicate', 'success', candidate.diagnosticData, candidate.participant);
          results.push(successResult(candidate.clientId, true));
          continue;
        }

        rows.push([
          new Date(candidate.timestamp),
          neutralizeFormula(candidate.participantId),
          neutralizeFormula(candidate.uuid),
          (typeof candidate.campus === 'string' && candidate.campus !== '')
            ? neutralizeFormula(candidate.campus)
            : ''
        ]);
        writtenCandidates.push({ candidate: candidate, key: key });
      }

      if (rows.length > 0) {
        const startRow = rawScanSheet.getLastRow() + 1;
        rawScanSheet
          .getRange(startRow, 1, rows.length, SCAN_HEADERS.RAW_SCANS.length)
          .setValues(rows);
        SpreadsheetApp.flush();
      }

      for (let w = 0; w < writtenCandidates.length; w += 1) {
        markDuplicateCached(writtenCandidates[w].key);
        results.push(successResult(writtenCandidates[w].candidate.clientId, false));
      }
    } catch (writeError) {
      const resolvedClientIds = {};
      for (let r = 0; r < results.length; r += 1) {
        resolvedClientIds[results[r].client_id] = true;
      }
      for (let u = 0; u < toWrite.length; u += 1) {
        if (!resolvedClientIds[toWrite[u].clientId]) {
          logDiagnostic(
            'error',
            'scan_error',
            'server_error',
            toWrite[u].diagnosticData,
            toWrite[u].participant,
            String(writeError)
          );
          results.push(errorResult(toWrite[u].clientId, 'server_error'));
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  return results;
}

/**
 * One Raw_Scans read (at most) covering every accepted scan in the batch,
 * instead of one read per scan. Returns a map of duplicateKey -> true for
 * every (participantId, uuid) pair already recorded, sourced from the
 * cache where possible and the sheet otherwise. Matches found via a live
 * read are cached for future requests.
 */
function loadKnownDuplicateKeys(rawScanSheet, accepted) {
  const known = {};
  const uncachedKeys = [];
  const keyToPair = {};

  for (let i = 0; i < accepted.length; i += 1) {
    const pair = accepted[i];
    const key = duplicateKey(pair.participantId, pair.uuid);
    if (isDuplicateCached(key)) {
      known[key] = true;
    } else if (!keyToPair[key]) {
      keyToPair[key] = { participantId: pair.participantId, uuid: pair.uuid };
      uncachedKeys.push(key);
    }
  }

  if (uncachedKeys.length === 0) {
    return known;
  }

  const existingRows = readDataRows(rawScanSheet, SCAN_HEADERS.RAW_SCANS.length);
  const sheetKeys = {};
  for (let r = 0; r < existingRows.length; r += 1) {
    const rowKey = duplicateKey(
      String(existingRows[r][1]),
      String(existingRows[r][2]).trim().toUpperCase()
    );
    sheetKeys[rowKey] = true;
  }

  for (let u = 0; u < uncachedKeys.length; u += 1) {
    const key = uncachedKeys[u];
    if (sheetKeys[key]) {
      known[key] = true;
      markDuplicateCached(key);
    }
  }

  return known;
}

function duplicateKey(participantId, uuid) {
  return sha256Hex(String(participantId) + '\u0001' + String(uuid));
}

function isDuplicateCached(key) {
  return CacheService.getScriptCache().get(DUPLICATE_CACHE_PREFIX + key) === '1';
}

function markDuplicateCached(key) {
  CacheService.getScriptCache().put(DUPLICATE_CACHE_PREFIX + key, '1', DUPLICATE_CACHE_TTL_SECONDS);
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

/**
 * Cached wrapper around findActiveParticipant. Caches both outcomes (found
 * vs not-found/inactive) because participant_url is small and effectively
 * static for the duration of an event. See PARTICIPANT_CACHE_TTL_SECONDS
 * for the revocation/rotation tradeoff this implies.
 */
function findActiveParticipantCached(sheet, tokenHash) {
  const cache = CacheService.getScriptCache();
  const cacheKey = PARTICIPANT_CACHE_PREFIX + tokenHash;
  const cached = cache.get(cacheKey);
  if (cached !== null) {
    return cached === '' ? null : { id: cached };
  }

  const participant = findActiveParticipant(sheet, tokenHash);
  cache.put(cacheKey, participant ? participant.id : '', PARTICIPANT_CACHE_TTL_SECONDS);
  return participant;
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

/**
 * Cached wrapper around a valid_tickets lookup. Only ever caches a
 * confirmed-true result, so a cache miss (never seen, or the entry
 * expired) always falls back to a live read of the ticket column rather
 * than trusting absence-from-cache as a rejection. This means a UUID can
 * never be authorized because of stale cache state, and a brand-new
 * ticket becomes usable immediately rather than being bounded by the
 * cache TTL.
 */
function isValidTicketCached(sheet, uuid) {
  const cache = CacheService.getScriptCache();
  const cacheKey = VALID_TICKET_CACHE_PREFIX + uuid;
  if (cache.get(cacheKey) === '1') {
    return true;
  }

  const found = ticketExists(sheet, uuid);
  if (found) {
    cache.put(cacheKey, '1', VALID_TICKET_CACHE_TTL_SECONDS);
  }
  return found;
}

function ticketExists(sheet, uuid) {
  return readDataRows(sheet, SCAN_HEADERS.VALID_TICKETS.length)
    .some(function(row) {
      return String(row[0]).trim().toUpperCase() === uuid;
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

function sha256Hex(value) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );

  return digest.map(function(byte) {
    return ((byte + 256) % 256).toString(16).padStart(2, '0');
  }).join('');
}

function hashToken(token) {
  return sha256Hex(token);
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
