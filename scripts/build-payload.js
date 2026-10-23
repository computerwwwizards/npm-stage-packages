import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

function createTarHeader(name, size, mode, uid, gid, mtime, typeflag) {
  const buf = Buffer.alloc(512);

  // name (100)
  buf.write(name, 0, Math.min(name.length, 100), 'utf8');
  // mode (8)
  buf.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'utf8');
  // uid (8)
  buf.write(uid.toString(8).padStart(7, '0') + '\0', 108, 8, 'utf8');
  // gid (8)
  buf.write(gid.toString(8).padStart(7, '0') + '\0', 116, 8, 'utf8');
  // size (12)
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  // mtime (12)
  buf.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  // chksum blank (8)
  buf.write('        ', 148, 8, 'utf8');
  // typeflag (1)
  buf.write(typeflag, 156, 1, 'utf8');

  // compute checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += buf[i];
  }

  buf.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

function createGzipTar(files) {
  const chunks = [];

  for (const file of files) {
    const name = file.name;
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const header = createTarHeader(name, content.length, 0o644, 0, 0, Date.now(), '0');
    chunks.push(header);
    chunks.push(content);

    const remainder = content.length % 512;
    if (remainder > 0) {
      chunks.push(Buffer.alloc(512 - remainder));
    }
  }

  // 2 empty 512-byte blocks at end
  chunks.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(chunks);
  return zlib.gzipSync(tarBuffer);
}

export function buildNpmPackagePayload(packageName, catalogEntry, version = '0.0.0-staged') {
  const pkgManifest = {
    name: packageName,
    version: version,
    description: catalogEntry.description || '',
    license: catalogEntry.license || 'MIT',
    repository: catalogEntry.repository || '',
    readme: catalogEntry.readme || '# ' + packageName + '\n\nReserved package name.'
  };

  const manifestStr = JSON.stringify(pkgManifest, null, 2);
  const readmeStr = pkgManifest.readme;

  const tarballGzip = createGzipTar([
    { name: 'package/package.json', content: manifestStr },
    { name: 'package/README.md', content: readmeStr }
  ]);

  const tarballBase64 = tarballGzip.toString('base64');
  const shasum = crypto.createHash('sha1').update(tarballGzip).digest('hex');
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tarballGzip).digest('base64');

  const filename = `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;

  const payload = {
    _id: packageName,
    name: packageName,
    'dist-tags': {
      staged: version
    },
    versions: {
      [version]: {
        name: packageName,
        version: version,
        description: pkgManifest.description,
        license: pkgManifest.license,
        repository: pkgManifest.repository,
        readme: pkgManifest.readme,
        _id: `${packageName}@${version}`,
        dist: {
          shasum: shasum,
          integrity: integrity,
          tarball: `https://registry.npmjs.org/${packageName}/-/${filename}`
        }
      }
    },
    _attachments: {
      [filename]: {
        content_type: 'application/gzip',
        data: tarballBase64,
        length: tarballGzip.length
      }
    }
  };

  return payload;
}

function main() {
  const catalogPath = path.resolve(process.cwd(), 'catalog.json');
  const outputDir = path.resolve(process.cwd(), 'payloads');

  if (!fs.existsSync(catalogPath)) {
    console.error(`catalog.json not found at ${catalogPath}`);
    process.exit(1);
  }

  const catalogContent = fs.readFileSync(catalogPath, 'utf8');
  const catalog = JSON.parse(catalogContent || '{}');

  const packageNames = Object.keys(catalog);
  if (packageNames.length === 0) {
    console.log('No packages found in catalog.json. Nothing to build.');
    return;
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const pkgName of packageNames) {
    const entry = catalog[pkgName];
    const payload = buildNpmPackagePayload(pkgName, entry);

    const safeFilename = pkgName.replace(/^@/, '').replace(/[/]/g, '__') + '.json';
    const outputPath = path.join(outputDir, safeFilename);

    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`Generated staging payload for ${pkgName} -> ${outputPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
