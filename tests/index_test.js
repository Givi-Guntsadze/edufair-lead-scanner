const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const STORAGE_KEY = 'edufair_scan_queue';
const VALID_TOKEN = 'a'.repeat(64);
const TEST_API_URL = 'https://script.google.com/macros/s/test-deployment/exec';
const DEPLOYED_API_URL = 'https://script.google.com/macros/s/AKfycby6LOkfukNUs45lPizNuFrGCzAzQEo0WNCRHgajRSGvhCTF0j1JrTDpsyygHW89Bwzw/exec';

function createElement(tagName, innerHTMLWrites) {
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    className: '',
    id: '',
    textContent: '',
    disabled: false,
    classList: {
      add(className) {
        const classes = new Set(element.className.split(/\s+/).filter(Boolean));
        classes.add(className);
        element.className = [...classes].join(' ');
      },
      remove(className) {
        element.className = element.className
          .split(/\s+/)
          .filter(value => value && value !== className)
          .join(' ');
      }
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

function createHarness({
  search = '?uni=constructor',
  hash = `#token=${VALID_TOKEN}`,
  initialQueue,
  storage = new Map(),
  online = false,
  apiUrl = TEST_API_URL,
  fetchResponses = []
} = {}) {
  const innerHTMLWrites = [];
  const elements = new Map();
  const fetchCalls = [];
  const consoleMessages = [];
  const responseQueue = [...fetchResponses];
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

  async function fetch(url, options) {
    fetchCalls.push({ url, options });
    const queued = responseQueue.shift() ?? { result: 'success', duplicate: false };
    if (queued instanceof Error) throw queued;
    return {
      ok: queued.ok ?? true,
      async json() {
        if (queued.jsonError) throw new Error('invalid json');
        return queued.body ?? queued;
      }
    };
  }

  const context = {
    console: {
      error(...values) { consoleMessages.push(['error', ...values.map(String)]); },
      log(...values) { consoleMessages.push(['log', ...values.map(String)]); },
      warn(...values) { consoleMessages.push(['warn', ...values.map(String)]); }
    },
    Date,
    document,
    fetch,
    Html5Qrcode,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    navigator: { onLine: online },
    setInterval: () => 0,
    setTimeout: callback => {
      callback();
      return 0;
    },
    URL,
    URLSearchParams,
    window: {
      addEventListener() {},
      crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
      location: { search, hash }
    }
  };

  const html = fs.readFileSync('index.html', 'utf8');
  const scriptStart = html.lastIndexOf('<script>');
  const sourceStart = html.indexOf('>', scriptStart) + 1;
  const sourceEnd = html.indexOf('</script>', sourceStart);
  let source = html.slice(sourceStart, sourceEnd);

  if (apiUrl !== undefined) {
    source = source.replace(
      /const API_URL\s*=\s*[^;]+;/,
      `const API_URL = ${JSON.stringify(apiUrl)};`
    );
  }

  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'index.html' });

  return {
    context,
    consoleMessages,
    elements,
    fetchCalls,
    innerHTMLWrites,
    queue: () => JSON.parse(storage.get(STORAGE_KEY) ?? '[]'),
    scannerStarts: () => scannerStarts,
    storage,
    async flushPromises() {
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('uses the deployed fair-scan-file Apps Script URL', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.ok(html.includes(`const API_URL = '${DEPLOYED_API_URL}';`));
  assert.doesNotMatch(html, /const API_URL = UNCONFIGURED_API_URL;/);
  assert.throws(
    () => createHarness({ apiUrl: null }),
    /Invalid participant link or scanner deployment configuration/
  );
});

test('loads a verified same-origin cross-browser QR decoder', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const scannerPath = 'vendor/html5-qrcode.min.js';

  assert.match(html, /<script src="vendor\/html5-qrcode\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  assert.equal(fs.existsSync(scannerPath), true, 'vendored QR decoder is missing');

  const digest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(scannerPath))
    .digest('hex');
  assert.equal(
    digest,
    '660b12437b1d747e3e68b8be0685c08cb728140110ad213f167b14b66f8b1d8e'
  );
});

test('does not start without a participant token', () => {
  assert.throws(
    () => createHarness({ hash: '' }),
    /Invalid participant link or scanner deployment configuration/
  );
});

test('does not start with a malformed or formula-prefixed participant link', () => {
  assert.throws(
    () => createHarness({ hash: '#token=short' }),
    /Invalid participant link or scanner deployment configuration/
  );
  assert.throws(
    () => createHarness({ search: '?uni=%3DIMPORTDATA' }),
    /Invalid participant link or scanner deployment configuration/
  );
});

test('accepts an organizer-defined participant identifier', () => {
  const participantId = 'თსუ / Tbilisi 2026';
  const harness = createHarness({ search: `?uni=${encodeURIComponent(participantId)}` });
  assert.equal(harness.scannerStarts(), 1);
  assert.equal(harness.elements.get('uni-name').textContent, participantId);
});

test('renders legacy stored QR content as text and never renders the token', () => {
  const payload = '<img src=x onerror="globalThis.compromised=true">';
  const harness = createHarness({
    initialQueue: [{
      id: 'existing-scan',
      participantId: 'constructor',
      token: VALID_TOKEN,
      uuid: payload,
      timestamp: '2026-07-27T12:00:00.000Z',
      status: 'pending'
    }]
  });

  assert.equal(
    harness.innerHTMLWrites.some(write =>
      write.value.includes(payload) || write.value.includes(VALID_TOKEN)
    ),
    false,
    'attacker-controlled QR content or token reached innerHTML'
  );

  const listItem = harness.elements.get('scans-list').children[0];
  assert.equal(listItem.querySelector('.scan-uuid').textContent, payload);
  assert.equal(harness.elements.get('uni-name').textContent, 'constructor');
});

test('does not queue an invalid scanned ticket identifier', () => {
  const harness = createHarness();
  harness.context.onScanSuccess('=1+1');
  assert.deepEqual(harness.queue(), []);
});

test('persists the participant credential with an offline scan', () => {
  const storage = new Map();
  const firstHarness = createHarness({ storage, online: false });
  firstHarness.context.onScanSuccess('A1B2C3D4');

  assert.equal(firstHarness.fetchCalls.length, 0);
  assert.equal(firstHarness.queue()[0].participantId, 'constructor');
  assert.equal(firstHarness.queue()[0].token, VALID_TOKEN);
  assert.equal(firstHarness.queue()[0].status, 'pending');

  const restoredHarness = createHarness({ storage, online: false });
  assert.equal(restoredHarness.queue()[0].token, VALID_TOKEN);
  assert.equal(restoredHarness.elements.get('scans-list').children.length, 1);
});

test('posts credentials in the body without putting the token in the URL', async () => {
  const harness = createHarness({ online: true });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();

  assert.equal(harness.fetchCalls.length, 1);
  const call = harness.fetchCalls[0];
  assert.equal(call.url, TEST_API_URL);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(call.url, new RegExp(VALID_TOKEN));

  const body = new URLSearchParams(call.options.body);
  assert.equal(body.get('participant_id'), 'constructor');
  assert.equal(body.get('token'), VALID_TOKEN);
  assert.equal(body.get('uuid'), 'A1B2C3D4');
  assert.equal(harness.queue()[0].status, 'synced');
  assert.equal(
    harness.consoleMessages.flat().some(value => value.includes(VALID_TOKEN)),
    false,
    'token was logged'
  );
});

test('treats a server duplicate as synchronized', async () => {
  const harness = createHarness({
    online: true,
    fetchResponses: [{ result: 'success', duplicate: true }]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();
  assert.equal(harness.queue()[0].status, 'synced');
});

for (const code of ['unauthorized', 'invalid_request', 'invalid_ticket']) {
  test(`marks ${code} as rejected and does not retry it`, async () => {
    const harness = createHarness({
      online: true,
      fetchResponses: [{ result: 'error', code }]
    });
    harness.context.onScanSuccess('A1B2C3D4');
    await harness.flushPromises();
    assert.equal(harness.queue()[0].status, 'rejected');
    await harness.context.sync();
    assert.equal(harness.fetchCalls.length, 1);
  });
}

test('keeps server-busy scans pending for a later retry', async () => {
  const harness = createHarness({
    online: true,
    fetchResponses: [
      { result: 'error', code: 'server_busy' },
      { result: 'success', duplicate: false }
    ]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();
  assert.equal(harness.queue()[0].status, 'pending');

  await harness.context.sync();
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.queue()[0].status, 'synced');
});

test('keeps network failures pending without logging credentials', async () => {
  const harness = createHarness({
    online: true,
    fetchResponses: [new Error(`network failure ${VALID_TOKEN}`)]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();
  assert.equal(harness.queue()[0].status, 'pending');
  assert.equal(
    harness.consoleMessages.flat().some(value => value.includes(VALID_TOKEN)),
    false,
    'network error leaked the token to logs'
  );
});
