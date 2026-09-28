import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as tar from 'tar';

import { resolveRowAccessAppTarball } from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';

// The installed version with its patch number raised by one: the smallest
// version a redeploy may carry.
export const nextRowAccessAppVersion = (): string => {
  const [major, minor, patch] = resolveRowAccessAppTarball()
    .version.split('.')
    .map(Number);

  return `${major}.${minor}.${patch + 1}`;
};

// The built tarball with only package.json's version changed: what a
// redeploy of the same app looks like to the server.
export const buildRowAccessTarballWithVersion = async (
  version: string,
): Promise<Buffer> => {
  const workDir = join(tmpdir(), `spirit-row-access-${randomUUID()}`);
  const outputPath = join(workDir, 'app.tgz');

  await fs.mkdir(workDir, { recursive: true });

  try {
    await tar.x({ file: resolveRowAccessAppTarball().path, cwd: workDir });

    const packageJsonPath = join(workDir, 'package', 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    await fs.writeFile(
      packageJsonPath,
      JSON.stringify({ ...packageJson, version }, null, 2),
    );

    await tar.c({ gzip: true, file: outputPath, cwd: workDir }, ['package']);

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
};
