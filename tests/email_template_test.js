const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const TEMPLATE_PATH = process.env.EMAIL_TEMPLATE_PATH ||
  'email-templates/confirmation-email.html';
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const expressionMatch = template.match(
  /<strong>\{\{([\s\S]*?\$json\.Name[\s\S]*?)\}\}<\/strong>/
);

assert.ok(expressionMatch, 'registrant-name n8n expression is missing');
const nameExpression = expressionMatch[1].trim();

function renderName(name, includeName = true) {
  const json = {};
  if (includeName) json.Name = name;
  return vm.runInNewContext(nameExpression, { $json: json });
}

test('preserves the existing n8n Name field and Unicode names', () => {
  assert.match(nameExpression, /\$json\.Name/);
  assert.equal(renderName('ნინო გელაშვილი'), 'ნინო გელაშვილი');
});

test('escapes every HTML metacharacter in a registrant name', () => {
  const hostileName = '<img src=x onerror="alert(\'x\')">&';
  assert.equal(
    renderName(hostileName),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;'
  );
});

test('renders missing and null names as empty text', () => {
  assert.equal(renderName(undefined, false), '');
  assert.equal(renderName(null), '');
});

test('safely serializes non-string JSON values before escaping', () => {
  assert.equal(renderName(2026), '2026');
  assert.equal(renderName(true), 'true');
  assert.equal(
    renderName(['ნინო', '<b>']),
    '[&quot;ნინო&quot;,&quot;&lt;b&gt;&quot;]'
  );
  assert.equal(
    renderName({ toString: '<img src=x onerror=alert(1)>' }),
    '{&quot;toString&quot;:&quot;&lt;img src=x onerror=alert(1)&gt;&quot;}'
  );
});
