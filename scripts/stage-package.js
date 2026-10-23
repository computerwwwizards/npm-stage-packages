// scripts/stage-package.js
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

const PAYLOAD_PATH = process.env.PAYLOAD_PATH || '/tmp/npm-payload/staging-payload.json';
const EXPECTED_INTEGRITY = process.env.EXPECTED_INTEGRITY;
const PACKAGE_NAME = process.env.PACKAGE_NAME;
const NPM_STAGE_TOKEN = process.env.NPM_STAGE_TOKEN;

/**
 * Constant-time comparison of two integrity strings.
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function verifyIntegrity(actual, expected) {
  const actualBuf = Buffer.from(actual, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

async function main() {
  if (!NPM_STAGE_TOKEN) {
    throw new Error('Missing NPM_STAGE_TOKEN environment variable.');
  }
  if (!EXPECTED_INTEGRITY || !PACKAGE_NAME) {
    throw new Error('Missing EXPECTED_INTEGRITY or PACKAGE_NAME environment variable.');
  }

  // 1. Read payload and verify SHA-512 integrity against Job 1 output
  const rawPayload = readFileSync(PAYLOAD_PATH, 'utf8');
  const actualIntegrity = `sha512-${createHash('sha512').update(rawPayload).digest('base64')}`;

  if (!verifyIntegrity(actualIntegrity, EXPECTED_INTEGRITY)) {
    throw new Error(
      `Payload integrity mismatch! Expected ${EXPECTED_INTEGRITY}, got ${actualIntegrity}`,
    );
  }

  const parsedPayload = JSON.parse(rawPayload);
  if (parsedPayload.name !== PACKAGE_NAME) {
    throw new Error(
      `Package name mismatch! Expected ${PACKAGE_NAME}, payload contains ${parsedPayload.name}`,
    );
  }

  const encodedPkgName = encodeURIComponent(PACKAGE_NAME);
  const registryUrl = `https://registry.npmjs.org/${encodedPkgName}`;

  // 2. Query registry first to skip if already published
  const checkResponse = await fetch(registryUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.npm.install-v1+json',
      Authorization: `Bearer ${NPM_STAGE_TOKEN}`,
    },
  });

  if (checkResponse.status === 200) {
    console.log(`Package ${PACKAGE_NAME} already exists in the npm registry. Skipping stage.`);
    return;
  }

  if (checkResponse.status !== 404) {
    const errBody = await checkResponse.text();
    throw new Error(`Unexpected status checking registry (${checkResponse.status}): ${errBody}`);
  }

  // 3. Stage the package via PUT (using x-npm-publish-phase: stage header / staging endpoint)
  console.log(`Staging ${PACKAGE_NAME} to ${registryUrl}...`);
  const stageResponse = await fetch(registryUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${NPM_STAGE_TOKEN}`,
      'Content-Type': 'application/json',
      'npm-command': 'stage',
    },
    body: rawPayload,
  });

  if (!stageResponse.ok) {
    const errorText = await stageResponse.text();
    // Handle idempotency if the version was already staged in a prior run
    if (
      stageResponse.status === 409 ||
      errorText.includes('cannot modify pre-existing version')
    ) {
      console.log(`Version for ${PACKAGE_NAME} is already staged. Treating as no-op.`);
      return;
    }
    throw new Error(`Failed to stage ${PACKAGE_NAME} (HTTP ${stageResponse.status}): ${errorText}`);
  }

  console.log(
    `Successfully staged ${PACKAGE_NAME}. Log in to npmjs.com to promote with 2FA and configure Trusted Publishing (OIDC).`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
