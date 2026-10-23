import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

const PAYLOAD_PATH = process.env.PAYLOAD_PATH || '/tmp/npm-payload/staging-payload.json';
const EXPECTED_INTEGRITY = process.env.EXPECTED_INTEGRITY;
const PACKAGE_NAME = process.env.PACKAGE_NAME;
const NPM_STAGE_TOKEN = process.env.NPM_STAGE_TOKEN;

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
  const metadataUrl = `https://registry.npmjs.org/${encodedPkgName}`;
  const stageUrl = `https://registry.npmjs.org/-/stage/package/${encodedPkgName}`;

  const checkResponse = await fetch(metadataUrl, {
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

  console.log(`Staging ${PACKAGE_NAME} to ${stageUrl}...`);
  const stageResponse = await fetch(stageUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NPM_STAGE_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'npm-command': 'stage',
    },
    body: rawPayload,
  });

  if (!stageResponse.ok) {
    const errorText = await stageResponse.text();
    if (
      stageResponse.status === 409 ||
      errorText.includes('cannot modify pre-existing version') ||
      errorText.includes('already staged')
    ) {
      console.log(`Version for ${PACKAGE_NAME} is already staged. Treating as no-op.`);
      return;
    }
    throw new Error(`Failed to stage ${PACKAGE_NAME} (HTTP ${stageResponse.status}): ${errorText}`);
  }

  const result = await stageResponse.json().catch(() => ({}));
  console.log(
    `Successfully staged ${PACKAGE_NAME} (stageId: ${result.stageId ?? 'created'}). Log in to npmjs.com to approve with 2FA and configure Trusted Publishing (OIDC).`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
