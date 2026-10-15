/**
 * More than one WorkBuddy sign-in per variant.
 *
 * The desktop apps keep exactly one signed-in account each, and the bridge
 * reads that login. To let a user keep, say, a work account and a personal
 * account side by side, a **profile** is a *copy* of the desktop app's auth
 * file taken while that account was signed in.
 *
 * Switching points the credential store's `desktopPath` at that copy, so the
 * store decrypts it with the machine's at-rest key exactly as it does for the
 * live file. Refresh results are written to a profile-owned file instead
 * (`ownPath`), which leaves the copy as the captured login; the store's
 * existing rule — whichever of the two expires later wins — then picks up
 * rotations without either side clobbering the other.
 *
 * What this deliberately is **not**: account rotation to dodge a quota. The
 * upstream's per-account limit (code 6004) is exactly what would be evaded,
 * so switching is a user action on a settings page, never automatic.
 *
 * @module hana-broke/account-profiles
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ACTIVE_FILE = "active.json";
const PROFILE_FILE = "profile.json";
const CAPTURED_AUTH_FILE = "desktop-auth.info";
const OWN_CREDENTIAL_FILE = "own-credential.json";

/** Per-variant directory holding every profile of that variant. */
export function profilesDir(dataDir, variantId) {
	return join(dataDir, "profiles", variantId);
}

/** One profile's directory. */
function profileDir(dataDir, variantId, profileId) {
	return join(profilesDir(dataDir, variantId), profileId);
}

/** Whether a string is safe to use as a profile id. */
function validId(id) {
	return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

/**
 * Turn a display name into a stable, filesystem-safe id.
 *
 * The result must satisfy {@link validId} — otherwise the profile directory
 * would exist but never be listed, activatable or deletable, because every one
 * of those paths validates the id first. A name that slugifies to nothing
 * (all non-ASCII, say) falls back to a generic id; the display name is stored
 * separately and is what the settings page shows.
 */
function slugify(name) {
	const base = String(name)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	// Must start with an alphanumeric character.
	const usable = base.replace(/^[^a-z0-9]+/, "").replace(/-+$/g, "");
	return (usable === "" ? "profile" : usable).slice(0, 48);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temp, path);
}

/** Build a store over an explicit auth file, for reading or verifying a capture. */
function storeOver(chunk, variant, desktopPath, ownPath) {
	return new chunk.WorkBuddyCredentialStore({
		variant,
		keyProvider: chunk.atRestKeyProviderFor(variant),
		desktopPath,
		ownPath,
		// Verification and display must never rotate anything: a capture is a
		// snapshot of someone else's login file.
		refresh: async () => {
			throw new Error("采集校验不会续期令牌");
		},
	});
}

/**
 * The account currently signed in to the desktop app, as a capturable path.
 *
 * The candidates come from the **store**, not from the module-level helper:
 * that helper returns the platform's generic paths (the same list for both
 * variants), while the store appends the variant's own file name
 * (`workbuddy-desktop-ai.info` vs `workbuddy-desktop.info`). Capturing from
 * the generic list silently copied the *other* variant's login.
 *
 * @param {object} store a store with no profile override (the live desktop app)
 * @returns {string|undefined}
 */
export function liveDesktopAuthPath(store) {
	for (const candidate of store.resolveDesktopCandidates()) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

/**
 * Read one profile back: who it is, and whether it still works.
 *
 * Never refreshes, so it is safe to call while listing profiles on a settings
 * page. A profile can stop working for two reasons worth telling apart: the
 * captured login belongs to the other variant (region mismatch), or it was
 * sealed by a WorkBuddy installation whose key this machine no longer has.
 *
 * @returns {Promise<{state: string, reason?: string, reasonCode?: string, uid?: string, domain?: string, expiresAt?: string}>}
 */
export async function describeProfile(chunk, variant, dataDir, profileId) {
	const dir = profileDir(dataDir, variant.id, profileId);
	const store = storeOver(chunk, variant, join(dir, CAPTURED_AUTH_FILE), join(dir, OWN_CREDENTIAL_FILE));
	try {
		const credential = await store.resolve();
		return {
			state: "signed-in",
			uid: credential.uid ?? "",
			...(credential.domain === undefined ? {} : { domain: credential.domain }),
			...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
			expiresAt: new Date(credential.expiresAtMs).toISOString(),
		};
	} catch (error) {
		const status = await store.status();
		return {
			state: status.state,
			...(status.reasonCode === undefined ? {} : { reasonCode: status.reasonCode }),
			reason: status.reason ?? (error instanceof Error ? error.message : String(error)),
		};
	}
}

/**
 * Capture the desktop app's current sign-in as a new profile.
 *
 * The copy is verified before it is kept: a capture that does not authenticate
 * as *this* variant is deleted and reported, because a bad profile would
 * otherwise replace a working account the moment it is activated.
 *
 * @param {object} options
 * @param {object} options.chunk loaded upstream module
 * @param {object} options.variant
 * @param {string} options.dataDir
 * @param {string} options.name display name for the profile
 * @param {string} [options.sourcePath] explicit auth file; default: the live desktop login
 * @returns {Promise<{ id: string, name: string, sourcePath: string, account: object }>}
 */
export async function captureProfile(options) {
	const { chunk, variant, dataDir, name } = options;
	if (typeof name !== "string" || name.trim() === "") throw new Error("请给这个档案起个名字");
	const sourcePath = options.sourcePath ?? liveDesktopAuthPath(options.liveStore ?? storeOver(chunk, variant, undefined, undefined));
	if (sourcePath === undefined) {
		throw new Error(
			`没有找到 ${variant.displayName} 的登录文件：请先在桌面 App 里登录一个账号，再回来采集。`,
		);
	}
	if (!existsSync(sourcePath)) throw new Error(`登录文件不存在：${sourcePath}`);

	const base = slugify(name);
	// Defence in depth: an id that fails this would create a profile that can
	// never be listed, activated or deleted.
	if (!validId(base)) throw new Error(`无法从名字生成合法的档案 id：${name}`);
	let id = base;
	for (let index = 2; existsSync(profileDir(dataDir, variant.id, id)); index += 1) id = `${base}-${index}`;
	const dir = profileDir(dataDir, variant.id, id);
	mkdirSync(dir, { recursive: true });
	copyFileSync(sourcePath, join(dir, CAPTURED_AUTH_FILE));

	const described = await describeProfile(chunk, variant, dataDir, id);
	if (described.state !== "signed-in") {
		rmSync(dir, { recursive: true, force: true });
		const hint =
			described.reasonCode === "credential-region-mismatch"
				? `这个文件里的账号属于另一个版本（${variant.displayName} 需要它自己的登录）。`
				: "这个文件读不出来，可能来自另一次 WorkBuddy 安装。";
		throw new Error(`采集到的登录文件不能用：${hint}${described.reason === undefined ? "" : ` 详情：${described.reason}`}`);
	}

	writeJson(join(dir, PROFILE_FILE), {
		id,
		name: name.trim(),
		variant: variant.id,
		capturedAt: new Date().toISOString(),
		sourcePath,
		...(described.uid === undefined ? {} : { uid: described.uid }),
	});
	return { id, name: name.trim(), sourcePath, account: described };
}

/**
 * Credential-store options for one profile.
 *
 * `undefined` profile means "follow the desktop app", which is the default and
 * keeps the historic behaviour (and shares the plugin-owned credential file
 * with the DeepSeek Harness plugin, including its lock).
 *
 * @param {object} chunk loaded upstream module
 * @param {object} variant
 * @param {string|undefined} profileId active profile id, or undefined
 * @param {string} dataDir bridge data directory
 * @returns {{ desktopPath?: string, ownPath?: string }}
 */
export function profileStoreOptions(dataDir, variant, profileId) {
	if (profileId === undefined) return {};
	const dir = profileDir(dataDir, variant.id, profileId);
	return {
		desktopPath: join(dir, CAPTURED_AUTH_FILE),
		ownPath: join(dir, OWN_CREDENTIAL_FILE),
	};
}

/** Where a profile keeps the captured desktop auth file. */
export function capturedAuthPath(dataDir, variantId, profileId) {
	return join(profileDir(dataDir, variantId, profileId), CAPTURED_AUTH_FILE);
}

/** Every profile of one variant, newest first. */
export function listProfiles(dataDir, variantId) {
	const dir = profilesDir(dataDir, variantId);
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
	const profiles = [];
	for (const id of entries) {
		if (!validId(id)) continue;
		const meta = readJson(join(dir, id, PROFILE_FILE));
		let capturedAt = meta?.capturedAt;
		if (capturedAt === undefined) {
			try {
				capturedAt = statSync(join(dir, id, CAPTURED_AUTH_FILE)).mtime.toISOString();
			} catch {
				capturedAt = undefined;
			}
		}
		profiles.push({
			id,
			name: typeof meta?.name === "string" && meta.name !== "" ? meta.name : id,
			capturedAt,
			...(meta?.sourcePath === undefined ? {} : { sourcePath: meta.sourcePath }),
		});
	}
	profiles.sort((a, b) => String(b.capturedAt ?? "").localeCompare(String(a.capturedAt ?? "")));
	return profiles;
}

/** The active profile id for a variant, or undefined for "follow the desktop app". */
export function activeProfile(dataDir, variantId) {
	const value = readJson(join(profilesDir(dataDir, variantId), ACTIVE_FILE));
	const id = value?.active;
	if (typeof id !== "string" || !validId(id)) return undefined;
	return existsSync(profileDir(dataDir, variantId, id)) ? id : undefined;
}

/**
 * Select the active profile (`undefined` restores "follow the desktop app").
 *
 * @returns {string|undefined} the id that is now active
 */
export function setActiveProfile(dataDir, variantId, profileId) {
	const file = join(profilesDir(dataDir, variantId), ACTIVE_FILE);
	if (profileId === undefined || profileId === null || profileId === "") {
		rmSync(file, { force: true });
		return undefined;
	}
	if (!validId(profileId)) throw new Error(`非法的档案 id：${String(profileId)}`);
	if (!existsSync(profileDir(dataDir, variantId, profileId))) throw new Error(`档案不存在：${profileId}`);
	writeJson(file, { active: profileId, switchedAt: new Date().toISOString() });
	return profileId;
}

/** Remove one profile. Deleting the active one falls back to the desktop app. */
export function deleteProfile(dataDir, variantId, profileId) {
	if (!validId(profileId)) throw new Error(`非法的档案 id：${String(profileId)}`);
	const dir = profileDir(dataDir, variantId, profileId);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	if (activeProfile(dataDir, variantId) === profileId) setActiveProfile(dataDir, variantId, undefined);
	return true;
}
