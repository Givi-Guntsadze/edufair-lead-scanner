const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

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

  getRow() {
    return this.row;
  }

  getNumRows() {
    return this.numRows;
  }

  getSheet() {
    return this.sheet;
  }
}

class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows.map(row => [...row]);
  }

  getName() {
    return this.name;
  }

  getLastRow() {
    return this.rows.length;
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  setCell(row, column, value) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < column) this.rows[row - 1].push('');
    this.rows[row - 1][column - 1] = value;
  }
}

class FakeSpreadsheet {
  constructor(participantRows) {
    this.sheets = new Map([
      ['participant_url', new FakeSheet('participant_url', participantRows)],
      ['other', new FakeSheet('other', [['Header'], ['Value']])]
    ]);
  }

  getSheetByName(name) {
    return this.sheets.get(name) ?? null;
  }
}

function defaultRows() {
  return [
    ['Participant_Name', 'Participant_ID', 'Token_Hash', 'Active', 'Scanner_URL'],
    ['Constructor University', 'constructor', '', '', ''],
    ['IE University', 'ie', '', '', '']
  ];
}

function createEnvironment({ rows = defaultRows(), uuidValues } = {}) {
  const spreadsheet = new FakeSpreadsheet(rows);
  const uuids = [...(uuidValues ?? [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666'
  ])];
  let activeRange = spreadsheet.getSheetByName('participant_url').getRange(2, 1, 1, 5);

  const context = {
    console: { error() {}, log() {} },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(text) {
        return { text, setMimeType() { return this; } };
      }
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getActiveRange: () => activeRange
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(algorithm, value) {
        return [...crypto.createHash('sha256').update(value, 'utf8').digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      },
      getUuid() {
        if (uuids.length === 0) throw new Error('No deterministic UUID left');
        return uuids.shift();
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), context, { filename: 'Code.gs' });
  if (fs.existsSync('ParticipantLinks.gs')) {
    vm.runInContext(
      fs.readFileSync('ParticipantLinks.gs', 'utf8'),
      context,
      { filename: 'ParticipantLinks.gs' }
    );
  }

  return {
    context,
    participantSheet: spreadsheet.getSheetByName('participant_url'),
    otherSheet: spreadsheet.getSheetByName('other'),
    setActiveRange(range) { activeRange = range; }
  };
}

{
  const harness = createEnvironment();
  assert.equal(
    typeof harness.context.generateParticipantUrls,
    'function',
    'generateParticipantUrls must be implemented'
  );

  const result = harness.context.generateParticipantUrls();
  assert.equal(result.generated, 2);
  assert.equal(result.skipped, 0);

  const constructorRow = harness.participantSheet.rows[1];
  assert.match(constructorRow[2], /^[a-f0-9]{64}$/);
  assert.equal(constructorRow[3], true);
  assert.match(
    constructorRow[4],
    /^https:\/\/givi-guntsadze\.github\.io\/edufair-lead-scanner\/\?uni=constructor#token=[a-f0-9]{64}$/
  );

  const originalRows = harness.participantSheet.rows.map(row => [...row]);
  const secondGeneration = harness.context.generateParticipantUrls();
  assert.equal(secondGeneration.generated, 0);
  assert.equal(secondGeneration.skipped, 2);
  assert.deepEqual(harness.participantSheet.rows, originalRows);

  harness.setActiveRange(harness.participantSheet.getRange(2, 1, 1, 5));
  const rotation = harness.context.rotateSelectedParticipantUrl();
  assert.equal(rotation.participantId, 'constructor');
  assert.notEqual(harness.participantSheet.rows[1][2], originalRows[1][2]);
  assert.notEqual(harness.participantSheet.rows[1][4], originalRows[1][4]);
  assert.equal(harness.participantSheet.rows[1][0], 'Constructor University');
  assert.equal(harness.participantSheet.rows[1][1], 'constructor');
  assert.equal(harness.participantSheet.rows[1][3], true);
}

for (const [label, rows, expectedError] of [
  [
    'duplicate IDs',
    [
      defaultRows()[0],
      ['One', 'same', '', '', ''],
      ['Two', 'same', '', '', '']
    ],
    /Duplicate Participant_ID: same/
  ],
  [
    'formula-prefixed ID',
    [defaultRows()[0], ['Unsafe', '=IMPORTDATA', '', '', '']],
    /Invalid Participant_ID/
  ],
  [
    'missing participant name',
    [defaultRows()[0], ['', 'constructor', '', '', '']],
    /Invalid Participant_Name/
  ],
  [
    'partial existing credential',
    [defaultRows()[0], ['Constructor', 'constructor', 'a'.repeat(64), true, '']],
    /incomplete existing credential/
  ]
]) {
  const harness = createEnvironment({ rows });
  assert.throws(() => harness.context.generateParticipantUrls(), expectedError, label);
}

{
  const harness = createEnvironment();
  harness.setActiveRange(harness.participantSheet.getRange(1, 1, 1, 5));
  assert.throws(
    () => harness.context.rotateSelectedParticipantUrl(),
    /Select exactly one participant data row/
  );

  harness.setActiveRange(harness.otherSheet.getRange(2, 1, 1, 1));
  assert.throws(
    () => harness.context.rotateSelectedParticipantUrl(),
    /Select a row in participant_url/
  );
}

{
  const harness = createEnvironment();
  assert.throws(
    () => harness.context.validateHttpsScannerBaseUrl('http://scanner.example/'),
    /SCANNER_BASE_URL must be an HTTPS URL/
  );
}

console.log('Participant link generation tests passed');
