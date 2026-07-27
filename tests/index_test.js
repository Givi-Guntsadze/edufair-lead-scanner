const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const STORAGE_KEY = 'edufair_scan_queue';

function createElement(tagName, innerHTMLWrites) {
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    className: '',
    id: '',
    textContent: '',
    disabled: false,
    classList: {
      add() {},
      remove() {}
    },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    prepend(child) {
      this.children.unshift(child);
    },
    remove() {},
    querySelector(selector) {
      if (!selector.startsWith('.')) return null;
      const className = selector.slice(1);
      const pending = [...this.children];
      while (pending.length > 0) {
        const child = pending.shift();
        if (child.className.split(/\s+/).includes(className)) return child;
        pending.push(...child.children);
      }
      return null;
    }
  };

  let innerHTML = '';
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = value;
      innerHTMLWrites.push({ element, value });
    }
  });

  return element;
}

function createHarness({ search = '?uni=HARVARD', initialQueue } = {}) {
  const innerHTMLWrites = [];
  const elements = new Map();
  const storage = new Map();
  let scannerStarts = 0;

  if (initialQueue !== undefined) {
    storage.set(STORAGE_KEY, JSON.stringify(initialQueue));
  }

  const document = {
    body: createElement('body', innerHTMLWrites),
    createElement: tagName => createElement(tagName, innerHTMLWrites),
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement('div', innerHTMLWrites));
      }
      return elements.get(id);
    }
  };

  function Html5Qrcode() {}
  Html5Qrcode.prototype.start = function start() {
    scannerStarts += 1;
    return Promise.resolve();
  };

  const context = {
    console: { error() {}, log() {}, warn() {} },
    document,
    fetch: async () => ({ ok: false }),
    Html5Qrcode,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    navigator: { onLine: false },
    setInterval: () => 0,
    setTimeout: () => 0,
    URLSearchParams,
    window: {
      addEventListener() {},
      crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
      location: { search }
    }
  };

  const html = fs.readFileSync('index.html', 'utf8');
  const scriptStart = html.lastIndexOf('<script>');
  const sourceStart = html.indexOf('>', scriptStart) + 1;
  const sourceEnd = html.indexOf('</script>', sourceStart);
  const source = html.slice(sourceStart, sourceEnd);

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'index.html' });

  return {
    context,
    elements,
    innerHTMLWrites,
    queue: () => JSON.parse(storage.get(STORAGE_KEY) ?? '[]'),
    scannerStarts: () => scannerStarts
  };
}

test('renders stored QR content as text instead of HTML', () => {
  const payload = '<img src=x onerror="globalThis.compromised=true">';
  const harness = createHarness({
    initialQueue: [{
      id: 'existing-scan',
      uni: 'HARVARD',
      uuid: payload,
      timestamp: '2026-07-27T12:00:00.000Z',
      status: 'pending'
    }]
  });

  assert.equal(
    harness.innerHTMLWrites.some(write => write.value.includes(payload)),
    false,
    'attacker-controlled QR content reached innerHTML'
  );

  const listItem = harness.elements.get('scans-list').children[0];
  assert.equal(listItem.querySelector('.scan-uuid').textContent, payload);
});

test('does not queue an invalid scanned ticket identifier', () => {
  const harness = createHarness();
  harness.context.onScanSuccess('=1+1');
  assert.deepEqual(harness.queue(), []);
});

test('queues a valid scanned ticket identifier', () => {
  const harness = createHarness();
  harness.context.onScanSuccess('A1B2C3D4');
  assert.equal(harness.queue().length, 1);
  assert.equal(harness.queue()[0].uuid, 'A1B2C3D4');
});

test('accepts an organizer-defined university identifier', () => {
  const uni = 'თსუ / Tbilisi 2026';
  const harness = createHarness({ search: `?uni=${encodeURIComponent(uni)}` });
  assert.equal(harness.scannerStarts(), 1);
  assert.equal(harness.elements.get('uni-name').textContent, uni);
});

test('rejects formula-prefixed university identifiers before starting the scanner', () => {
  for (const uni of ['=IMPORTDATA', "'=IMPORTDATA"]) {
    assert.throws(
      () => createHarness({ search: `?uni=${encodeURIComponent(uni)}` }),
      /Invalid uni parameter/
    );
  }
});
