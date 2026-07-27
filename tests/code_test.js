const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const VALID_TOKEN = 'a'.repeat(64);
const UNKNOWN_TOKEN = 'c'.repeat(64);
const INACTIVE_TOKEN = 'b'.repeat(64);
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
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numColumns }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }

  setValues(values) {
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
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map(row => [...row]);
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
    this.sheets = new Map(
      Object.entries(sheetDefinitions).map(([name, rows]) => [name, new FakeSheet(name, rows)])
    );
  }

  getSheetByName(name) {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }

  getId() {
    return SCAN_SPREADSHEET_ID;
  }
}

function defaultSheets() {
  return {
    Raw_Scans: [
      ['Timestamp', 'Uni_ID', 'UUID']
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
      ]
    ],
    valid_tickets: [
      ['UUID'],
      ['A1B2C3D4'],
      ['12345678']
    ]
  };
}

function createEnvironment(
  sheetDefinitions = defaultSheets(),
  {
    activeSpreadsheetAvailable = true,
    configuredSpreadsheetId = SCAN_SPREADSHEET_ID
  } = {}
) {
  const spreadsheet = new FakeSpreadsheet(sheetDefinitions);
  let lockReleases = 0;
  const loggedErrors = [];
  const openedSpreadsheetIds = [];
  const scriptProperties = new Map();
  if (configuredSpreadsheetId) {
    scriptProperties.set('SCAN_SPREADSHEET_ID', configuredSpreadsheetId);
  }
  const context = {
    console: {
      error(message) { loggedErrors.push(String(message)); },
      log() {}
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
    LockService: {
      getScriptLock() {
        return {
          waitLock() {},
          releaseLock() { lockReleases += 1; }
        };
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSpreadsheetAvailable ? spreadsheet : null,
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
    loggedErrors,
    openedSpreadsheetIds,
    scriptProperties,
    lockReleases: () => lockReleases
  };
}

function parseResponse(output) {
  return JSON.parse(output.text);
}

function postRequest(context, {
  participantId = 'constructor',
  token = VALID_TOKEN,
  uuid = 'A1B2C3D4',
  timestamp = '2026-07-27T12:00:00.000Z'
} = {}) {
  return parseResponse(context.doPost({
    parameter: {
      participant_id: participantId,
      token,
      uuid,
      timestamp
    },
    postData: {
      type: 'application/x-www-form-urlencoded',
      contents: new URLSearchParams({
        participant_id: participantId,
        token,
        uuid,
        timestamp
      }).toString()
    }
  }));
}

{
  const { context, spreadsheet, lockReleases } = createEnvironment();
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
  assert.equal(lockReleases(), 1);

  assert.deepEqual(postRequest(context), {
    result: 'success',
    duplicate: true
  });
  assert.equal(rawScans.getLastRow(), 2, 'duplicate scans must not append');
  assert.equal(lockReleases(), 2);
}

for (const [label, request, expectedCode] of [
  ['mismatched participant ID', { participantId: 'ie' }, 'unauthorized'],
  ['unknown token', { token: UNKNOWN_TOKEN }, 'unauthorized'],
  ['inactive participant', { participantId: 'inactive', token: INACTIVE_TOKEN }, 'unauthorized'],
  ['unknown ticket', { uuid: 'ZZZZZZZZ' }, 'invalid_ticket'],
  ['short token', { token: 'abc' }, 'invalid_request'],
  ['lowercase ticket', { uuid: 'a1b2c3d4' }, 'invalid_request'],
  ['formula participant', { participantId: '=IMPORTDATA' }, 'invalid_request'],
  ['invalid timestamp', { timestamp: 'not-a-date' }, 'invalid_request']
]) {
  const { context, spreadsheet } = createEnvironment();
  const response = postRequest(context, request);
  assert.equal(response.result, 'error', label);
  assert.equal(response.code, expectedCode, label);
  assert.equal(
    spreadsheet.getSheetByName('Raw_Scans').getLastRow(),
    1,
    `${label} must not append`
  );
  assert.doesNotMatch(JSON.stringify(response), new RegExp(request.token ?? VALID_TOKEN));
}

{
  const sheets = defaultSheets();
  delete sheets.valid_tickets;
  const { context, loggedErrors } = createEnvironment(sheets);
  const response = postRequest(context);
  assert.deepEqual(response, { result: 'error', code: 'server_error' });
  assert.equal(loggedErrors.length, 1);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(VALID_TOKEN));
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
  '\uFF1D1+1',
  '\uFF0B1+1',
  '\uFF0D1+1',
  '\uFF201+1'
]) {
  const { context } = createEnvironment();
  assert.equal(context.neutralizeFormula(value), `'${value}`);
}

console.log('Code.gs authorization tests passed');
