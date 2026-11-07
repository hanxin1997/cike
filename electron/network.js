'use strict';
const { Readable } = require('stream');

function responseHeaders(values = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item != null) headers.append(name, String(item));
  }
  return headers;
}

// Electron net.fetch cancels a manual redirect instead of exposing its 3xx
// response on some releases. net.request exposes the redirect event, allowing
// the callers to enforce their own HTTPS/host/redirect-count rules unchanged.
function createDesktopFetch(net) {
  return (url, options = {}) => new Promise((resolve, reject) => {
    if (options.redirect && options.redirect !== 'manual') return reject(new Error('Desktop downloads require explicit redirect validation.'));
    if (options.signal?.aborted) return reject(options.signal.reason || new Error('Download aborted'));
    let request, stream, settled = false, intentionalAbort = false;
    const removeAbort = () => options.signal?.removeEventListener('abort', abort);
    const fail = error => {
      if (intentionalAbort) return;
      if (stream) stream.destroy(error);
      if (!settled) { settled = true; removeAbort(); reject(error); }
    };
    const abort = () => {
      const error = options.signal.reason || new Error('Download aborted');
      fail(error);
      request?.abort();
    };
    try {
      // The default Electron session retains OS proxy resolution; cookies are
      // deliberately excluded from public software/kernel download requests.
      request = net.request({ url: String(url), method: 'GET', redirect: 'manual', useSessionCookies: false });
      for (const [name, value] of Object.entries(options.headers || {})) request.setHeader(name, value);
      request.on('error', fail);
      request.on('redirect', (status, method, location, rawHeaders) => {
        if (settled) return;
        const headers = responseHeaders(rawHeaders);
        headers.set('location', location);
        settled = true; intentionalAbort = true; removeAbort();
        resolve({ status, headers, body: null, redirected: false });
        // Do not follow automatically: the caller validates the next URL first.
        request.abort();
      });
      request.on('response', response => {
        if (settled) return;
        stream = response;
        response.on('error', fail);
        response.once('end', removeAbort);
        response.once('close', removeAbort);
        settled = true;
        resolve({ status: response.statusCode, headers: responseHeaders(response.headers), body: Readable.toWeb(response), redirected: false });
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      request.end();
    } catch (error) { fail(error); }
  });
}
module.exports = { createDesktopFetch };
