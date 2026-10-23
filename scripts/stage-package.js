import fs from 'node:fs';
import path from 'node:path';

export async function stagePackagePayload(payloadPath, npmToken, registryUrl = 'https://registry.npmjs.org') {
  if (!fs.existsSync(payloadPath)) {
    throw new Error(`Payload file does not exist: ${payloadPath}`);
  }

  const payloadStr = fs.readFileSync(payloadPath, 'utf8');
  const payload = JSON.parse(payloadStr);
  const packageName = payload.name;

  if (!packageName) {
    throw new Error(`Invalid payload at ${payloadPath}: missing 'name'`);
  }

  // URL-encode package name for scoped packages (e.g. @org/pkg -> @org%2fpkg)
  const encodedName = packageName.startsWith('@')
    ? '@' + encodeURIComponent(packageName.slice(1))
    : encodeURIComponent(packageName);

  const targetUrl = `${registryUrl.replace(/\/$/, '')}/${encodedName}`;

  console.log(`Staging package ${packageName} to ${targetUrl}...`);

  const response = await fetch(targetUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${npmToken}`,
      'npm-command': 'publish',
      'npm-is-stage': 'true'
    },
    body: payloadStr
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Failed to stage ${packageName}: HTTP ${response.status} ${response.statusText}\nResponse: ${responseText}`);
  }

  console.log(`Successfully staged ${packageName}! Response: ${responseText}`);
  return responseText;
}

async function main() {
  const payloadsDir = path.resolve(process.cwd(), 'payloads');
  const npmToken = process.env.NPM_TOKEN;

  if (!npmToken) {
    console.error('Error: NPM_TOKEN environment variable is not set.');
    process.exit(1);
  }

  if (!fs.existsSync(payloadsDir)) {
    console.log('No payloads directory found. Nothing to stage.');
    return;
  }

  const files = fs.readdirSync(payloadsDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No payload JSON files found in payloads/. Nothing to stage.');
    return;
  }

  for (const file of files) {
    const payloadPath = path.join(payloadsDir, file);
    try {
      await stagePackagePayload(payloadPath, npmToken);
    } catch (err) {
      console.error(`Error staging package from ${file}:`, err);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch(err => {
    console.error('Unhandled error during staging:', err);
    process.exit(1);
  });
}
