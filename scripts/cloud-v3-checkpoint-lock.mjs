import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync,
  rmSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readCheckpoint, stop, uuid } from '../src/v2/live-lifecycle-checkpoint.mjs';

const protocol = 'SHUDUO_CLOUD_CHECKPOINT_LOCK_V1';
const own = stat => typeof process.getuid === 'function' && stat.uid === process.getuid();
const busy = () => stop('原检查点已有锁或不可写，请核对原进程');
let cachedScope;

// A PID is useful only in the same boot and, on Linux, the same PID namespace.
// If the identity cannot be read, ordinary locking still works.
function localProcessScope() {
  if (cachedScope !== undefined) return cachedScope;
  cachedScope = null;
  try {
    const linux = process.platform === 'linux';
    if (!linux && process.platform !== 'darwin') return cachedScope;
    const boot = (linux ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      : execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'],
        {encoding:'utf8',timeout:1500,stdio:['ignore','pipe','pipe']})).trim().toLowerCase();
    const namespace = linux ? readlinkSync('/proc/self/ns/pid') : '';
    if (uuid.test(boot) && (!linux || /^pid:\[\d+\]$/.test(namespace)))
      cachedScope = createHash('sha256').update([process.platform, boot, namespace].join(':')).digest('hex');
  } catch { /* The lock will require manual inspection if abandoned. */ }
  return cachedScope;
}

function abandonedOwner(lockPath, scope) {
  if (!scope) return undefined;
  try {
    const parent = lstatSync(dirname(lockPath)), lock = lstatSync(lockPath);
    if (!parent.isDirectory() || !own(parent) || (parent.mode & 0o022) !== 0 ||
        !lock.isDirectory() || !own(lock) || (lock.mode & 0o777) !== 0o700) return undefined;
    const files = readdirSync(lockPath);
    if (files.length !== 1 || !files[0].endsWith('.json') || !uuid.test(files[0].slice(0,-5)))
      return undefined;
    const path = join(lockPath, files[0]);
    if (lstatSync(path).size > 512) return undefined;
    const {state} = readCheckpoint(path,{privateFile:true});
    if (state?.protocol !== protocol || state.scope !== scope ||
        !Number.isSafeInteger(state.pid) || state.pid <= 0 || state.pid > 2147483647) return undefined;
    try { process.kill(state.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return files[0]; }
  } catch { /* An unverifiable lock is left for manual inspection. */ }
  return undefined;
}

function claim(staging, lockPath) {
  try { renameSync(staging, lockPath); return true; }
  catch (error) {
    if (['EEXIST','ENOTEMPTY','ENOTDIR','EISDIR'].includes(error.code)) return false;
    throw error;
  }
}

function release(lockPath, owner) {
  // Only this owner's unique marker can be removed. Another process can
  // publish its populated directory over the empty one before rmdir.
  try { unlinkSync(join(lockPath, owner)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try { rmdirSync(lockPath); }
  catch (error) {
    if (!['ENOENT','EEXIST','ENOTEMPTY'].includes(error.code)) throw error;
  }
}

export async function withCloudCheckpoint(path, operation, {reconcile=false} = {}) {
  if (!isAbsolute(path)) stop('须使用原检查点的绝对路径');
  const lockPath = path + '.lock', owner = randomUUID() + '.json';
  const scope = localProcessScope();
  let staging, acquired = false;
  try {
    try {
      staging = mkdtempSync(join(dirname(lockPath), '.shuduo-checkpoint-lock-'));
      writeFileSync(join(staging, owner), JSON.stringify({protocol,pid:process.pid,scope}), {mode:0o600,flag:'wx'});
      acquired = claim(staging, lockPath);
      if (!acquired && reconcile) {
        const abandoned = abandonedOwner(lockPath, scope);
        if (abandoned) release(lockPath, abandoned);
        // An owner may have released its lock while we checked it.
        acquired = claim(staging, lockPath);
      }
    } catch { busy(); }
    if (!acquired) busy();
    return await operation();
  } finally {
    if (acquired) release(lockPath, owner);
    else if (staging) rmSync(staging, {recursive:true,force:true});
  }
}
