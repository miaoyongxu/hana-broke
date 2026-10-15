/**
 * Minimal stand-in for `@deepseek-ai/dsh-atomic-write`.
 *
 * `dsh-workbuddy-connect` imports `withFileLock` / `writeFileAtomic` from that
 * package, which ships inside the DeepSeek Harness runtime rather than in the
 * `.dsh` profile's node_modules. Running the plugin's credential store outside
 * DSH therefore needs these two functions; nothing else from the package is
 * used by the code path this bridge exercises.
 *
 * Behaviour kept identical where it is observable:
 * - writes go to a sibling temp file and are renamed into place, so a reader
 *   never sees a half-written credential;
 * - the lock is a `wx`-created `<path>.lock` file, which is also the name the
 *   plugin itself deletes in `logout()`.
 */

import { mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STALE_LOCK_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;
const LOCK_RETRY_MS = 40;

/**
 * Atomically replace `filePath` with `data`.
 *
 * @param {string} filePath destination
 * @param {string | Uint8Array} data payload
 * @param {{ mode?: number, dirMode?: number }} [options]
 */
export async function writeFileAtomic(filePath, data, options = {}) {
	const directory = dirname(filePath);
	await mkdir(directory, { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) });
	const tempPath = join(
		directory,
		`.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
	);
	try {
		await writeFile(tempPath, data, options.mode === undefined ? undefined : { mode: options.mode });
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

/** Whether a lock file left behind by a dead process may be reclaimed. */
async function lockIsStale(lockPath) {
	try {
		const info = await stat(lockPath);
		return Date.now() - info.mtimeMs > STALE_LOCK_MS;
	} catch {
		return false;
	}
}

/**
 * Run `fn` while holding an exclusive lock beside `filePath`.
 *
 * @template T
 * @param {string} filePath lock target; the lock lives at `${filePath}.lock`
 * @param {() => Promise<T> | T} fn critical section
 * @returns {Promise<T>}
 */
export async function withFileLock(filePath, fn) {
	const lockPath = `${filePath}.lock`;
	await mkdir(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			if (await lockIsStale(lockPath)) {
				await unlink(lockPath).catch(() => {});
				continue;
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lockPath, { force: true }).catch(() => {});
	}
}

export default { withFileLock, writeFileAtomic };
