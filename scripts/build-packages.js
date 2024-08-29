#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import https from 'node:https';

import limit from 'p-limit';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../');

const limitAssetDownloads = limit(1);

async function mapVersionsToReleases(versions) {
  const map = new Map();
  const versionsToFind = new Set(versions);

  let page = 1;
  while (versionsToFind.size > 0) {
    console.log('requesting page %d', page);
    const response = await fetch(`https://api.github.com/repos/stoplightio/spectral/releases?page=${page}`);
    if (response.status === 404) {
      // that's the end of the releases
      break;
    }
    if (response.status !== 200) {
      throw new Error(`release page ${page} had a response status ${response.status}, cannot find remaining versions`);
    }
    const releases = await response.json();

    if (page === 1 && versionsToFind.has('latest')) {
      map.set('latest', releases[0]);
      versionsToFind.delete('latest');
    }

    for (const release of releases) {
      if (!versionsToFind.has(release.tag_name)) {
        continue;
      }
      map.set(release.tag_name, release);
      versionsToFind.delete(release.tag_name);
    }

    page += 1;
  }

  return map;
}

function downloadAssetWorker(assetPath, url, size, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 && response.headers.location) {
        if (redirectCount > 5) {
          reject(new Error(`${response.statusCode} for ${url}, but exceeded maximum redirect count`));
        } else {
          console.log(`following redirect from ${url} to ${response.headers.location}`);
          resolve(downloadAssetWorker(assetPath, response.headers.location, size, redirectCount + 1));
        }
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`${response.statusCode} for ${url}`));
        return;
      }

      if (response.headers['content-length'] != size) {
        reject(new Error(`expecting ${size} for ${url}, got ${response.headers['content-length']}`));
        return;
      }

      console.log(`saving ${assetPath}`);
      response
        .pipe(createWriteStream(assetPath))
        .on('close', () => resolve(
          fs.chmod(assetPath, 0o555) // r-x
            .then(() => assetPath)
        ))
        .on('error', reject);
    })
      .on('error', reject);
  });
}

async function downloadAsset(pkgPath, { name, browser_download_url, size }) {
  const assetPath = path.join(pkgPath, name);
  return limitAssetDownloads(() => downloadAssetWorker(assetPath, browser_download_url, size));
}

async function createPackageJSON(pkgPath, release) {
  const pkgJSONPath = path.join(pkgPath, 'package.json');
  const { license } = await fetch(`https://raw.githubusercontent.com/stoplightio/spectral/${release.tag_name}/package.json`).then(response => response.json());
  await fs.writeFile(pkgJSONPath, JSON.stringify({
    name: 'spectral-binaries',
    version: release.name,
    description: `Binaries of Spectral ${release.name} (${release.html_url}), via npm`,
    repository: {
      url: 'https://github.com/PixnBits/spectral-binaries',
    },
    type: 'module',
    license,
  }, null, 2))
  return pkgJSONPath;
}

async function createReadme(pkgPath, release) {
  const readmePath = path.join(pkgPath, 'README.md');
  await fs.writeFile(readmePath, `\
# Spectral Binaries

Binaries of [Spectral ${release.name}](${release.html_url}), via npm

${release.body || ''}
`);
  return readmePath;
}

(async function main(nodePath, selfPath, ...versions) {
  try {
    if (versions.length < 1) {
      process.exitCode = 2;
      throw new Error('must provide a version, e.g. "latest", "6.11.1"');
    }

    const releaseMap = await mapVersionsToReleases(versions);

    for await (const [, release] of releaseMap.entries()) {
      console.log('release %s has %d assets', release.tag_name, release.assets.length);
      const pkgPath = path.join(PROJECT_ROOT, 'dist', release.tag_name);
      await fs.mkdir(pkgPath, { recursive: true });
      const results = await Promise.all([
        createPackageJSON(pkgPath, release),
        createReadme(pkgPath, release),
        ...release.assets.map((asset) => downloadAsset(pkgPath, asset)),
      ]);

      console.log(`files stored for release ${release.tag_name}`, results);
    }

    // `$ npm publish` in the workflow

  } catch (error) {
    process.exitCode = 1;
    console.error('unexpected error', error);
  }
}(...process.argv));