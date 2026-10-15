/**
 * Per-account model visibility.
 *
 * WorkBuddy's roster differs per account, and two accounts on one machine can
 * see different models. HanaAgent's own hide list is per *provider*, not per
 * account, so hiding is applied here instead: the declaration pushed to
 * HanaAgent simply omits the hidden ids for the account that is active right
 * now. Switching accounts therefore changes the declaration, which the sync
 * detects and re-registers on its own.
 *
 * @module hana-broke/model-visibility
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Stable key for the account behind a credential.
 *
 * Mirrors the upstream plugin's rule: an account with no uid gets **no key**,
 * because keying preferences on an empty uid would silently share one hide
 * list between every such account.
 *
 * @param {{ uid?: string, enterpriseId?: string }} credential
 * @returns {string|undefined}
 */
export function accountKeyOf(credential) {
	const uid = typeof credential?.uid === "string" ? credential.uid.trim() : "";
	if (uid === "") return undefined;
	const enterprise = typeof credential?.enterpriseId === "string" ? credential.enterpriseId.trim() : "";
	return `${uid}:${enterprise}`;
}

function storePath(dataDir, variantId) {
	return join(dataDir, "visibility", `${variantId}.json`);
}

function read(dataDir, variantId) {
	try {
		const parsed = JSON.parse(readFileSync(storePath(dataDir, variantId), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Hidden model ids for one account.
 *
 * @returns {string[]} empty when nothing is hidden or the account has no key
 */
export function hiddenModels(dataDir, variantId, accountKey) {
	if (accountKey === undefined) return [];
	const all = read(dataDir, variantId);
	const list = all[accountKey];
	return Array.isArray(list) ? list.filter((id) => typeof id === "string" && id !== "") : [];
}

/**
 * Replace the hidden list for one account.
 *
 * @param {string[]} ids model ids to hide; an empty list forgets the entry
 * @returns {string[]} the stored list
 */
export function setHiddenModels(dataDir, variantId, accountKey, ids) {
	if (accountKey === undefined) throw new Error("该账号没有 uid，无法按账号保存模型显隐");
	const all = read(dataDir, variantId);
	const clean = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id !== ""))];
	if (clean.length === 0) delete all[accountKey];
	else all[accountKey] = clean;

	const path = storePath(dataDir, variantId);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
	renameSync(temp, path);
	return clean;
}
