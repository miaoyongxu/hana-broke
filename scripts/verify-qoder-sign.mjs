#!/usr/bin/env node
/**
 * Check the Qoder client against the public protocol vectors.
 *
 * `qoder-sign.mjs` reimplements a wire format that only exists inside Qoder's own
 * clients, so "it works on my machine" is not evidence: a signature that is wrong by one
 * byte looks exactly like a correct one until the gateway refuses it. This script pins
 * the arithmetic to frozen test vectors that the community published from Qoder CLI
 * 1.1.34 (Liki4/qodercli2api, `testdata/protocol/1.1.34/`), which record both the inputs
 * and the exact bytes the real client produced.
 *
 * Run it after touching `qoder-sign.mjs`, or when Qoder ships a new client and the bridge
 * starts getting 401s — it names which primitive drifted instead of failing vaguely.
 *
 *   node scripts/verify-qoder-sign.mjs [--fixtures <dir>]
 *
 * `--fixtures` points at a checkout of that repository's `testdata/protocol/1.1.34`
 * directory. Without it the script looks in a few conventional places and reports where
 * it looked if it finds nothing, because the vectors are not vendored here (they carry
 * the upstream project's licence, not this one's).
 *
 * Exit code 0 = every vector matched; 1 = at least one drifted or the fixtures are
 * missing.
 */

import { existsSync, readFileSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	COSY_SIGNED_PATH,
	buildAuthorization,
	cosyHeaders,
	decryptCredentialFile,
	qoderDecode,
	qoderEncode,
	requestIdFrom,
} from "../qoder-sign.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Where the vectors might live, in the order worth trying. */
function candidateFixtureDirs() {
	const explicit = process.argv.indexOf("--fixtures");
	if (explicit >= 0) {
		const value = process.argv[explicit + 1];
		return value === undefined ? [] : [resolve(value)];
	}
	return [
		join(ROOT, "test", "qoder-fixtures", "1.1.34"),
		join(ROOT, "..", "qoder-research", "qodercli2api", "testdata", "protocol", "1.1.34"),
		join(ROOT, "..", "qodercli2api", "testdata", "protocol", "1.1.34"),
	];
}

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
	checks += 1;
	if (condition) {
		process.stdout.write(`  ok    ${name}${detail === undefined ? "" : `  (${detail})`}\n`);
	} else {
		failures += 1;
		process.stdout.write(`  FAIL  ${name}${detail === undefined ? "" : `  (${detail})`}\n`);
	}
}

const fixtureDir = candidateFixtureDirs().find((dir) => existsSync(join(dir, "infer-user.json")));
if (fixtureDir === undefined) {
	const tried = candidateFixtureDirs();
	process.stdout.write("No protocol vectors found; looked in:\n");
	for (const dir of tried) process.stdout.write(`  ${dir}\n`);
	process.stdout.write(
		"\nFetch them with:\n" +
			"  git clone --depth 1 https://github.com/Liki4/qodercli2api\n" +
			"  node scripts/verify-qoder-sign.mjs --fixtures qodercli2api/testdata/protocol/1.1.34\n",
	);
	process.exit(1);
}

const read = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
const infer = read("infer-user.json");
const noOrg = read("infer-user-no-org.json");
const runtimeFields = read("runtime-fields.json");
const credential = read("credential.json");

process.stdout.write(`fixtures: ${fixtureDir}\n\n`);

//#region body codec

process.stdout.write("body codec (custom Base64 + outer-thirds rotation)\n");
const encoded = qoderEncode(infer.input.body_raw);
check("encode reproduces the recorded body", encoded === infer.expected.body_string, `${encoded.length} chars`);
check("decode is the exact inverse", qoderDecode(infer.expected.body_string).toString("utf8") === infer.input.body_raw);

//#endregion

//#region request id

process.stdout.write("\nCOSY request uuid\n");
const requestId = requestIdFrom(Buffer.from(infer.transcript.entropy_reads[2].bytes, "base64"));
const fixtureAuthorization = infer.expected.header.Authorization[0];
const fixturePayloadB64 = fixtureAuthorization.split(".")[1];
check("byte-reversal and masks reproduce the recorded uuid", Buffer.from(fixturePayloadB64, "base64").toString("utf8").includes(`"requestId":"${requestId}"`), requestId);

//#endregion

//#region signature

process.stdout.write("\nauthorization (MD5 over payload / key / date / body / path)\n");
const date = String(Math.floor(infer.transcript.unix_milli[0] / 1000));
const authorization = buildAuthorization({
	info: runtimeFields.expected.encrypt_user_info,
	cosyKey: runtimeFields.expected.key,
	encodedBody: encoded,
	signedPath: COSY_SIGNED_PATH,
	requestId,
	date,
	cosyVersion: infer.input.version,
});
check("payload bytes match", authorization.payloadB64 === fixturePayloadB64);
check("signature matches", authorization.authorization === fixtureAuthorization, authorization.signature);

//#endregion

//#region runtime fields

process.stdout.write("\nruntime fields (AES-128-CBC key==iv, RSA-wrapped key)\n");
const raw = Buffer.from(runtimeFields.transcript.entropy_reads[0].bytes, "base64");
const masked = Buffer.alloc(16);
for (let index = 0; index < 16; index += 1) masked[index] = raw[15 - index];
masked[6] = (masked[6] & 0x0f) | 0x40;
masked[8] = (masked[8] & 0x3f) | 0x80;
const tempKey = masked.toString("hex").slice(0, 16);
const decipher = createDecipheriv("aes-128-cbc", Buffer.from(tempKey, "utf8"), Buffer.from(tempKey, "utf8"));
const plain = Buffer.concat([
	decipher.update(Buffer.from(runtimeFields.expected.encrypt_user_info, "base64")),
	decipher.final(),
]).toString("utf8");
check("the recorded ciphertext decrypts to the recorded identity", plain === runtimeFields.input.raw);
check("the wrapped key is a 1024-bit RSA block", Buffer.from(runtimeFields.expected.key, "base64").length === 128);

//#endregion

//#region headers

process.stdout.write("\nheader map (conditional presence)\n");
const normalize = (name) => name.toLowerCase().replace(/-/g, "");
for (const [label, fixture, expectedCount] of [["full organization", infer, 22], ["no organization", noOrg, 18]]) {
	const user = fixture.input.user;
	const headers = cosyHeaders({
		authorization: expectedAuthorizationOf(fixture),
		date: Number(fixture.expected.header["Cosy-Date"][0]),
		cosyKey: user.key,
		uid: user.uid,
		machine: { machineId: fixture.input.machine_id, machineToken: fixture.input.machine_id },
		organizationId: user.organization_id,
		organizationTags: user.organization_tags,
		modelKey: fixture.input.model_key,
		modelSource: fixture.input.model_source,
		cosyVersion: fixture.input.version,
		dataPolicyAgreed: user.data_policy_agreed,
	});
	const built = new Map(Object.entries(headers).map(([name, value]) => [normalize(name), String(value)]));
	let mismatched = 0;
	for (const [name, value] of Object.entries(fixture.expected.header)) {
		const got = built.get(normalize(name));
		if (got === undefined || got !== String(value[0])) mismatched += 1;
		built.delete(normalize(name));
	}
	// The transport adds its own headers; only the protocol's are under test.
	const extra = [...built.keys()].filter((name) => name !== "useragent" && name !== "acceptencoding");
	check(`${label}: every recorded header matched`, mismatched === 0, `${Object.keys(fixture.expected.header).length} recorded`);
	check(`${label}: no unexplained extra headers`, extra.length === 0, extra.join(",") || "none");
	// `cosyHeaders` also sets User-Agent (the CLI's own), which the recorded map does not
	// include because Go's transport adds it. One over the recorded count is expected.
	check(`${label}: header count is the recorded matrix + user-agent`, Object.keys(headers).length === expectedCount + 1, `${Object.keys(headers).length} built, ${expectedCount} recorded`);
}

/** The authorization recorded in a fixture, which the header test only passes through. */
function expectedAuthorizationOf(fixture) {
	return fixture.expected.header.Authorization[0];
}

//#endregion

//#region credential file

process.stdout.write("\ncredential file (AES-128-CBC, key = machine_id[:16])\n");
const user = decryptCredentialFile(credential.expected.encrypted, credential.input.machine_key);
check("the recorded file decrypts to the recorded login", JSON.stringify(user) === JSON.stringify(JSON.parse(credential.expected.decrypted)));

//#endregion

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
