/**
 * Phase 7: a malicious website open in the owner's browser must not be able to
 * use the API on 127.0.0.1 — neither by a cross-site request (CSRF) nor by DNS
 * rebinding. Real processes, real browser.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { expect, test } from '@playwright/test';
import { BASE_URL, LONG_SUBTITLE, Stack } from './harness.js';

// Recent Chromium already blocks public pages from calling 127.0.0.1; other browsers do not.
// Switch that off so the test shows that the server refuses the request by itself.
test.use({
  launchOptions: {
    args: [
      '--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks',
    ],
  },
});

let stack: Stack;
test.afterEach(async () => {
  await stack.stop();
});

test('a website cannot use the API through the owner’s browser', async ({ page }) => {
  stack = new Stack();
  await stack.start();
  await stack.killWorker(); // keep the job queued
  const res = await fetch(`${BASE_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contentBase64: readFileSync(LONG_SUBTITLE).toString('base64'),
      targetLanguage: 'hr',
    }),
  });
  const { job } = (await res.json()) as { job: { id: string } };

  // A page on another website fires a cross-site "cancel" at the API on 127.0.0.1, the way a
  // malicious page would (no-cors: it cannot read the answer, but the request is sent).
  await page.route('http://attacker.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }),
  );
  await page.goto('http://attacker.test/');
  const sent = await page.evaluate(async (url) => {
    const r = await fetch(url, { method: 'POST', mode: 'no-cors' });
    return r.type;
  }, `${BASE_URL}/api/v1/jobs/${job.id}/cancel`);
  expect(sent).toBe('opaque'); // the browser did send it
  expect((await stack.job(job.id)).state).toBe('queued');

  // The dashboard's own request from its own origin still works.
  await page.goto(`${BASE_URL}/`);
  const own = await page.evaluate(
    async (url) => (await fetch(url, { method: 'POST' })).status,
    `${BASE_URL}/api/v1/jobs/${job.id}/cancel`,
  );
  expect(own).toBe(200);
  expect((await stack.job(job.id)).state).toBe('cancelled');

  // DNS rebinding: a request whose Host is a foreign name is refused.
  // (fetch cannot set Host, so this one goes through node:http)
  const rebinding = await new Promise<number>((done, fail) => {
    const url = new URL(`${BASE_URL}/api/v1/settings`);
    request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { host: 'evil.example' },
      },
      (r) => {
        r.resume();
        done(r.statusCode ?? 0);
      },
    )
      .on('error', fail)
      .end();
  });
  expect(rebinding).toBe(403);
});
