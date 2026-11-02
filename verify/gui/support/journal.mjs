// SPDX-License-Identifier: GPL-3.0-or-later
import { openSync, closeSync, writeSync, fsyncSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// The event stream survives SIGKILL. Report snapshots use atomic replacement.
export class Journal {
  constructor(directory) { this.directory = directory; this.fd = openSync(join(directory, 'events.jsonl'), 'a'); }
  event(type, data) {
    writeSync(this.fd, JSON.stringify({ at: new Date().toISOString(), type, data }) + '\n');
    fsyncSync(this.fd);
  }
  checkpoint(report) {
    const path = join(this.directory, 'report.json');
    writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n');
    const fd = openSync(path + '.tmp', 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(path + '.tmp', path);
  }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; } }
}
