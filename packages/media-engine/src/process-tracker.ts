import { execFile, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

interface ProcessRecord {
  pid: number;
  ownerPid: number;
  binary: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function commandOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'comm=', '-p', String(pid)], (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });
}

/**
 * FFmpeg outlives a worker that is killed outright: nothing ties the child to its parent, and a
 * closed progress pipe does not stop it. Recording each process on disk lets the next worker on this
 * machine find and kill what a dead one left behind.
 */
export class ProcessTracker {
  constructor(private readonly directory: string) {}

  private path(pid: number): string {
    return join(this.directory, `${pid}.json`);
  }

  /** Best effort: losing a record only risks one stray encoder, so it must not fail the job. */
  track(child: ChildProcess, binary: string): void {
    const { pid } = child;
    if (pid === undefined) return;
    const record: ProcessRecord = { pid, ownerPid: process.pid, binary: basename(binary) };
    const written = mkdir(this.directory, { recursive: true })
      .then(() => writeFile(this.path(pid), JSON.stringify(record)))
      .catch(() => undefined);
    child.once('close', () => {
      void written.then(() => rm(this.path(pid), { force: true }));
    });
  }

  /** Kills processes whose owner is dead. Returns how many it stopped. */
  async reap(): Promise<number> {
    const files = await readdir(this.directory).catch(() => []);
    let killed = 0;
    for (const file of files) {
      const path = join(this.directory, file);
      let record: ProcessRecord;
      try {
        record = JSON.parse(await readFile(path, 'utf8')) as ProcessRecord;
      } catch {
        await rm(path, { force: true });
        continue;
      }
      if (isAlive(record.ownerPid)) continue;
      // PIDs get reused, so only something still running this binary can be the process we started.
      const command = await commandOf(record.pid);
      if (command && basename(command) === record.binary) {
        try {
          process.kill(record.pid, 'SIGKILL');
          killed++;
        } catch {
          // It exited in the moment since the check, which is the outcome we wanted.
        }
      }
      await rm(path, { force: true });
    }
    return killed;
  }
}
