'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDesktopFetch } = require('../electron/network');

function fixture(onRequest) {
  const calls = [];
  return { calls, net: { request(options) {
    const request = new EventEmitter();
    request.headers = {};
    request.setHeader = (key, value) => { request.headers[key] = value; };
    request.abort = () => { request.aborted = true; queueMicrotask(() => request.emit('error', new Error('Redirect was cancelled'))); };
    request.end = () => queueMicrotask(() => onRequest(request, options));
    calls.push({ options, request });
    return request;
  } } };
}
function respond(request, status, body) {
  const response = new PassThrough();
  response.statusCode = status;
  response.headers = { 'content-length': [String(Buffer.byteLength(body))] };
  request.emit('response', response);
  response.end(body);
}

test('desktop transport exposes manual redirects without net.fetch cancellation and preserves session routing', async () => {
  const setup = fixture((request, options) => options.url.endsWith('/first')
    ? request.emit('redirect', 302, 'GET', 'https://cdn.fixture.invalid/final', { location: ['https://cdn.fixture.invalid/final'] })
    : respond(request, 200, 'kernel'));
  const fetch = createDesktopFetch(setup.net);
  const first = await fetch('https://cdn.fixture.invalid/first', { redirect: 'manual', headers: { 'User-Agent': 'CIKE' } });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), 'https://cdn.fixture.invalid/final');
  assert.equal(first.body, null);
  assert.equal(setup.calls[0].request.aborted, true);
  const next = await fetch(first.headers.get('location'), { redirect: 'manual' });
  assert.equal(await new Response(next.body).text(), 'kernel');
  assert.equal(setup.calls[0].options.redirect, 'manual');
  assert.equal(setup.calls[0].options.useSessionCookies, false);
});

test('desktop redirects are still rejected by kernel HTTPS policy', async () => {
  const { downloadFile } = require('../electron/chromium');
  const setup = fixture(request => request.emit('redirect', 302, 'GET', 'http://unsafe.invalid/kernel.zip', {}));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-desktop-net-'));
  try {
    await assert.rejects(downloadFile('https://cdn.fixture.invalid/first', path.join(dir, 'kernel.zip'), null, { fetch: createDesktopFetch(setup.net) }), /HTTPS/);
    assert.equal(setup.calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('desktop transport rejects request errors, observes abort, and propagates response failures', async () => {
  const broken = fixture(request => request.emit('error', new Error('network fixture failure')));
  await assert.rejects(createDesktopFetch(broken.net)('https://fixture.invalid', { redirect: 'manual' }), /network fixture failure/);
  const pending = fixture(() => {}), controller = new AbortController();
  const waiting = createDesktopFetch(pending.net)('https://fixture.invalid', { signal: controller.signal, redirect: 'manual' });
  controller.abort(new Error('fixture abort'));
  await assert.rejects(waiting, /fixture abort/);
  assert.equal(pending.calls[0].request.aborted, true);
  const interrupted = fixture(request => {
    const response = new PassThrough(); response.statusCode = 200; response.headers = {};
    request.emit('response', response);
    queueMicrotask(() => response.destroy(new Error('body fixture failure')));
  });
  const response = await createDesktopFetch(interrupted.net)('https://fixture.invalid', { redirect: 'manual' });
  await assert.rejects(new Response(response.body).text(), /body fixture failure/);
});
