import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { buildNpmPackagePayload } from '../scripts/build-payload.js';
import { stagePackagePayload } from '../scripts/stage-package.js';

test('buildNpmPackagePayload generates valid npm staging payload', () => {
  const entry = {
    repository: 'https://github.com/my-org/my-pkg',
    license: 'MIT',
    description: 'My awesome package'
  };

  const payload = buildNpmPackagePayload('@my-org/my-pkg', entry, '0.0.0-staged');

  assert.equal(payload._id, '@my-org/my-pkg');
  assert.equal(payload.name, '@my-org/my-pkg');
  assert.equal(payload['dist-tags'].staged, '0.0.0-staged');

  const versionData = payload.versions['0.0.0-staged'];
  assert.ok(versionData);
  assert.equal(versionData.name, '@my-org/my-pkg');
  assert.equal(versionData.description, 'My awesome package');
  assert.equal(versionData.license, 'MIT');
  assert.equal(versionData.repository, 'https://github.com/my-org/my-pkg');
  assert.ok(versionData.dist.shasum);
  assert.ok(versionData.dist.integrity);

  const attachments = payload._attachments;
  const attachmentKeys = Object.keys(attachments);
  assert.equal(attachmentKeys.length, 1);
  assert.equal(attachments[attachmentKeys[0]].content_type, 'application/gzip');
  assert.ok(attachments[attachmentKeys[0]].data);
});

test('stagePackagePayload sends correct PUT request with headers', async () => {
  let receivedHeaders = null;
  let receivedMethod = null;
  let receivedUrl = null;
  let receivedBody = '';

  const server = http.createServer((req, res) => {
    receivedMethod = req.method;
    receivedUrl = req.url;
    receivedHeaders = req.headers;

    req.on('data', chunk => {
      receivedBody += chunk;
    });

    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  const tmpPayloadPath = path.resolve(process.cwd(), 'test-payload.json');
  const dummyPayload = {
    name: '@my-org/my-pkg',
    versions: {}
  };
  fs.writeFileSync(tmpPayloadPath, JSON.stringify(dummyPayload), 'utf8');

  try {
    const result = await stagePackagePayload(tmpPayloadPath, 'test-npm-token', serverUrl);
    assert.equal(receivedMethod, 'PUT');
    assert.equal(receivedUrl, '/@my-org%2Fmy-pkg');
    assert.equal(receivedHeaders['authorization'], 'Bearer test-npm-token');
    assert.equal(receivedHeaders['npm-command'], 'publish');
    assert.equal(receivedHeaders['npm-is-stage'], 'true');
    assert.equal(receivedHeaders['content-type'], 'application/json');
    assert.equal(receivedBody, JSON.stringify(dummyPayload));
    assert.equal(result, JSON.stringify({ ok: true }));
  } finally {
    if (fs.existsSync(tmpPayloadPath)) {
      fs.unlinkSync(tmpPayloadPath);
    }
    server.close();
  }
});
