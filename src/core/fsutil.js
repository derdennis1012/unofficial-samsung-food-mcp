/** Small file helpers. */

import fs from 'node:fs';
import path from 'node:path';

/** Writes via a temp file in the same directory and renames it, so readers never see a partial file. */
export function writeFileAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
