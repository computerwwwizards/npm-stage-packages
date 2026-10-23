// scripts/build-payload.js
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const BOOTSTRAP_VERSION = '0.0.0-reserve.0';
const CATALOG_PATH = resolve(process.cwd(), 'catalog.json');
const OUTPUT_DIR = '/tmp/npm-payload';
const OUTPUT_FILE = join(OUTPUT_DIR, 'staging-payload.json');

/**
 * Normalizes a repository URL into the format expected by npm OIDC provenance.
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeRepoUrl(rawUrl) {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  const withPrefix = trimmed.startsWith('git+') ? trimmed : `git+${trimmed}`;
  return withPrefix.endsWith('.git') ? withPrefix : `${withPrefix}.git`;
}

/**
 * Builds an in-memory POSIX USTAR tar archive for a single file and gzips it.
 * Eliminates the need for `--allow-child-process` to call `tar` or `npm pack`.
 * @param {string} filename - Path inside archive (e.g., "package/package.json")
 * @param {Buffer} contentBuffer - File contents
 * @returns {Buffer} Gzipped tarball (.tgz)
 */
function createInMemoryTgz(filename, contentBuffer) {
  const header = Buffer.alloc(512, 0);

  // File name (100 bytes)
  header.write(filename, 0, 100, 'utf8');
  // File mode (8 bytes, octal)
  header.write('0000644\0', 100, 8, 'utf8');
  // UID & GID (8 bytes each, octal)
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  // File size in bytes (11 octal digits + null terminator)
  header.write(`${contentBuffer.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  // Mtime (fixed epoch timestamp for deterministic builds)
  header.write('00000000000\0', 136, 12, 'utf8');
  // Fill checksum spaces (8 spaces) before calculating checksum
  header.write('        ', 148, 8, 'utf8');
  // Typeflag ('0' = regular file)
  header.write('0', 156, 1, 'utf8');
  // USTAR indicator & version
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');

  // Compute header checksum
  let chksum = 0;
  for (let i = 0; i < 512; i += 1) {
    chksum += header[i];
  }
  header.write(`${chksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');

  // Pad file data to a multiple of 512 bytes
  const paddingLength = (512 - (contentBuffer.length % 512)) % 512;
  const padding = Buffer.alloc(paddingLength, 0);
  // End-of-archive marker (two 512-byte zero blocks)
  const endOfArchive = Buffer.alloc(1024, 0);

  const tarBuffer = Buffer.concat([header, contentBuffer, padding, endOfArchive]);
  return gzipSync(tarBuffer, { level: 9 });
}

function main() {
  const rawCatalog = readFileSync(CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(rawCatalog);

  // Target package can be passed via env TARGET_PACKAGE, or default to the first entry
  const targetPkgName = process.env.TARGET_PACKAGE || Object.keys(catalog)[0];

  if (!targetPkgName || !catalog[targetPkgName]) {
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'should_stage=false\n');
    }
    console.log('No valid target package found in catalog.json.');
    return;
  }

  const meta = catalog[targetPkgName];
  const unscopedName = targetPkgName.split('/').pop();
  const tarballFilename = `${unscopedName}-${BOOTSTRAP_VERSION}.tgz`;
  const encodedPkgName = targetPkgName.replace('/', '%2f');
  const registryUrl = `https://registry.npmjs.org/${encodedPkgName}`;

  // 1. Create minimal package.json
  const pkgJson = {
    name: targetPkgName,
    version: BOOTSTRAP_VERSION,
    description: meta.description ?? '',
    license: meta.license ?? 'MIT',
    repository: {
      type: 'git',
      url: normalizeRepoUrl(meta.repository),
    },
  };

  const pkgJsonBuffer = Buffer.from(`${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8');

  // 2. Build deterministic .tgz in memory
  const tgzBuffer = createInMemoryTgz('package/package.json', pkgJsonBuffer);

  // 3. Compute hashes required by the npm registry CouchDB packument
  const shasum = createHash('sha1').update(tgzBuffer).digest('hex');
  const sha512Base64 = createHash('sha512').update(tgzBuffer).digest('base64');
  const integrity = `sha512-${sha512Base64}`;

  // 4. Construct full npm PUT packument payload
  const packumentPayload = {
    _id: targetPkgName,
    name: targetPkgName,
    description: pkgJson.description,
    'dist-tags': {
      latest: BOOTSTRAP_VERSION,
    },
    versions: {
      [BOOTSTRAP_VERSION]: {
        name: targetPkgName,
        version: BOOTSTRAP_VERSION,
        description: pkgJson.description,
        license: pkgJson.license,
        repository: pkgJson.repository,
        _id: `${targetPkgName}@${BOOTSTRAP_VERSION}`,
        dist: {
          shasum,
          integrity,
          tarball: `${registryUrl}/-/${tarballFilename}`,
        },
      },
    },
    _attachments: {
      [tarballFilename]: {
        content_type: 'application/octet-stream',
        data: tgzBuffer.toString('base64'),
        length: tgzBuffer.length,
      },
    },
  };

  const serializedPayload = JSON.stringify(packumentPayload);
  const payloadIntegrity = `sha512-${createHash('sha512').update(serializedPayload).digest('base64')}`;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, serializedPayload, 'utf8');

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        'should_stage=true',
        `package_name=${targetPkgName}`,
        `integrity=${payloadIntegrity}`,
        '',
      ].join('\n'),
    );
  }

  console.log(`Built staging payload for ${targetPkgName} (${payloadIntegrity})`);
}

main();
