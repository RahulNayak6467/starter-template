import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';

for (const name of ['.env', '.env.test']) {
  const destination = new URL(`../${name}`, import.meta.url);
  try {
    await copyFile(
      new URL(`../${name}.example`, import.meta.url),
      destination,
      constants.COPYFILE_EXCL,
    );
    console.info(`Created ${name}`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      console.info(`Kept existing ${name}`);
    } else {
      throw error;
    }
  }
}

console.info('Next: pnpm services:up && pnpm db:migrate && pnpm dev');
