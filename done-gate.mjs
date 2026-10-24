#!/usr/bin/env node
// done-gate: a fail-closed release verdict.
//
// A requirements file lists what "done" means. Each release has an evidence
// file: the release identity (version, commit, package path, package SHA-256,
// platforms, source_clean) and one row per requirement. The verdict is DONE
// only when every requirement has exactly one row with status "pass",
// evidence text, and an artifact_sha256 equal to the SHA-256 of the package
// being judged. Anything else is NOT DONE.
//
// Rebuilding the package changes its hash, so every row recorded against the
// old bytes goes stale on its own. Nobody has to remember to re-check.
//
// It never fails open: a missing file, bad JSON, an unreadable package or an
// unknown status all end in NOT DONE.
//
// Exit codes: 0 DONE, 1 NOT DONE, 2 usage or I/O error (also NOT DONE).

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve through symlinks so the bundled example is found when this file is
// run from an npm bin link, from npx, or from a path that contains spaces.
const SCRIPT = realpathSync(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPT);
const BUNDLED_REQUIREMENTS = path.join(ROOT, "examples", "requirements.desktop-app.json");

const PASS = "pass";
// Statuses people write for "not done yet". They are reported under their own
// name. Any other value that is not exactly "pass" is invalid-status, so a
// typo such as "passed" or "PASS" can never pass.
const FAIL_STATUSES = new Set(["fail", "missing", "stale", "blocked", "skipped", "unverified", "n/a"]);
const DEFAULT_IDENTITY_FIELDS = ["version", "commit", "package_path", "package_sha256", "platforms", "source_clean"];
const SHA256_HEX = /^[0-9a-f]{64}$/;
const KIND_ORDER = ["identity", "stale", "missing", "duplicate", "invalid-status", "fail"];
const SHOW_PER_KIND = 12;

export class UsageError extends Error {}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isAbsent = (v) =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);
const short = (hash) => `${hash.slice(0, 12)}...`;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** SHA-256 of a file, read in chunks so a large package does not need to fit in memory. */
export function hashFile(file) {
  if (!statSync(file).isFile()) {
    throw Object.assign(new Error(`not a regular file: ${file}`), { code: "ENOTFILE" });
  }
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(file, "r");
  try {
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Validate a parsed requirements file. Throws UsageError when it is unusable:
 * an empty or ambiguous requirement set must never be able to produce DONE.
 */
export function normalizeRequirements(raw) {
  if (!isObject(raw)) throw new UsageError("requirements file must be a JSON object");
  const list = [];
  const add = (r, gate, where) => {
    if (!isObject(r) || typeof r.id !== "string" || r.id.trim() === "") {
      throw new UsageError(`${where}: every requirement needs a non-empty string "id"`);
    }
    list.push({ id: r.id, text: typeof r.text === "string" ? r.text : "", gate });
  };
  if (raw.gates !== undefined) {
    if (!Array.isArray(raw.gates)) throw new UsageError(`"gates" must be an array`);
    raw.gates.forEach((g, gi) => {
      if (!isObject(g) || !Array.isArray(g.requirements)) {
        throw new UsageError(`gates[${gi}] needs a "requirements" array`);
      }
      const name = typeof g.name === "string" && g.name.trim() ? g.name : `gate ${gi + 1}`;
      g.requirements.forEach((r, ri) => add(r, name, `gates[${gi}].requirements[${ri}]`));
    });
  }
  if (raw.requirements !== undefined) {
    if (!Array.isArray(raw.requirements)) throw new UsageError(`"requirements" must be an array`);
    raw.requirements.forEach((r, ri) => add(r, null, `requirements[${ri}]`));
  }
  if (list.length === 0) {
    throw new UsageError("requirements file declares no requirements; an empty list can never be DONE");
  }
  const seen = new Set();
  for (const r of list) {
    if (seen.has(r.id)) throw new UsageError(`requirement id "${r.id}" is declared more than once`);
    seen.add(r.id);
  }
  let fields = DEFAULT_IDENTITY_FIELDS;
  if (raw.release_identity_fields !== undefined) {
    const f = raw.release_identity_fields;
    if (!Array.isArray(f) || f.some((x) => typeof x !== "string" || x.trim() === "")) {
      throw new UsageError(`"release_identity_fields" must be an array of field names`);
    }
    fields = f;
  }
  // The package hash is what binds evidence to bytes. It is never optional.
  if (!fields.includes("package_sha256")) fields = ["package_sha256", ...fields];
  return { requirements: list, identityFields: fields };
}

function groupRows(rows, key) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!isObject(row) || isAbsent(row[key])) continue;
    const k = String(row[key]);
    map.set(k, [...(map.get(k) ?? []), row]);
  }
  return map;
}

// Returns null when the row passes, otherwise { kind, why }.
function judgeRow(rows = [], packageHash, missingWhy) {
  if (rows.length === 0) return { kind: "missing", why: missingWhy };
  if (rows.length > 1) return { kind: "duplicate", why: `${rows.length} evidence rows; exactly one is allowed` };
  const row = rows[0];

  // Evidence must be bound to the package under judgement.
  const bound = typeof row.artifact_sha256 === "string" ? row.artifact_sha256.trim().toLowerCase() : "";
  if (!bound) return { kind: "stale", why: "row names no artifact_sha256, so it is not bound to any package" };
  if (!SHA256_HEX.test(bound)) {
    return { kind: "stale", why: `artifact_sha256 ${JSON.stringify(row.artifact_sha256)} is not a SHA-256` };
  }
  if (packageHash && bound !== packageHash) {
    return { kind: "stale", why: `gathered against ${short(bound)}, not the current package ${short(packageHash)}` };
  }

  if (row.status !== PASS) {
    const detail = [row.why, row.evidence].find((t) => typeof t === "string" && t.trim());
    let kind = "invalid-status";
    let why;
    if (typeof row.status === "string" && FAIL_STATUSES.has(row.status)) {
      kind = row.status;
      why = `status "${row.status}"`;
    } else if (row.status === undefined) {
      why = "status is missing";
    } else {
      why = `status ${JSON.stringify(row.status)} is not "pass"; only the exact string "pass" passes`;
    }
    return { kind, why: detail ? `${why}: ${detail.trim()}` : why };
  }

  if (typeof row.evidence !== "string" || row.evidence.trim() === "") {
    return { kind: "fail", why: 'status is "pass" but there is no evidence text; an assertion is not evidence' };
  }
  return null;
}

function displayPath(p) {
  const rel = path.relative(process.cwd(), p);
  if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") return p;
  return rel;
}

/**
 * Judge one release. `evidence` and `requirements` are parsed JSON objects.
 * A relative release.package_path resolves against `baseDir`.
 * Returns { name, version, package_sha256, verdict, counts, failures }.
 */
export function judge(evidence, requirements, { baseDir = process.cwd() } = {}) {
  const reqs = normalizeRequirements(requirements);
  if (!isObject(evidence)) throw new UsageError("evidence must be a JSON object");
  const rel = isObject(evidence.release) ? evidence.release : {};
  const failures = [];
  const fail = (kind, id, why, gate) => failures.push(gate ? { kind, id, gate, why } : { kind, id, why });

  // Release identity. An unusable identity makes every row beneath it
  // meaningless, so these failures are listed first.
  for (const field of reqs.identityFields) {
    if (isAbsent(rel[field])) fail("identity", `RELEASE.${field}`, "release identity field is missing");
  }

  let packageHash = null;
  if (!isAbsent(rel.package_sha256)) {
    const h = typeof rel.package_sha256 === "string" ? rel.package_sha256.trim().toLowerCase() : "";
    if (SHA256_HEX.test(h)) packageHash = h;
    else fail("identity", "RELEASE.package_sha256", `${JSON.stringify(rel.package_sha256)} is not a SHA-256 (64 hex characters)`);
  }

  // A dirty tree means the package cannot be rebuilt from the recorded commit.
  if (rel.source_clean !== undefined && rel.source_clean !== true) {
    fail(
      "identity",
      "RELEASE.source_clean",
      `source_clean is ${JSON.stringify(rel.source_clean)}, so the package cannot be reproduced from the recorded commit`,
    );
  }

  const claimed = [];
  if (rel.platforms !== undefined && rel.platforms !== null) {
    if (!Array.isArray(rel.platforms) || rel.platforms.some((p) => typeof p !== "string" || p.trim() === "")) {
      fail("identity", "RELEASE.platforms", "platforms must be an array of non-empty strings");
    } else {
      for (const p of rel.platforms) if (!claimed.includes(p)) claimed.push(p);
    }
  }

  // If the package is named, the bytes on disk must still be the bytes the
  // evidence describes.
  if (!isAbsent(rel.package_path)) {
    if (typeof rel.package_path !== "string") {
      fail("identity", "RELEASE.package_path", "package_path must be a string");
    } else {
      const file = path.resolve(baseDir, rel.package_path);
      let actual = null;
      try {
        actual = hashFile(file);
      } catch (err) {
        const why =
          err.code === "ENOENT"
            ? `package not found: ${displayPath(file)}`
            : err.code === "ENOTFILE"
              ? `package is not a regular file: ${displayPath(file)}`
              : `cannot read package ${displayPath(file)}: ${err.message}`;
        fail("identity", "RELEASE.package_path", why);
      }
      if (actual && packageHash && actual !== packageHash) {
        fail(
          "identity",
          "RELEASE.package_sha256",
          `package on disk hashes ${short(actual)} but package_sha256 says ${short(packageHash)}; the package changed after the evidence was recorded`,
        );
      }
    }
  }

  // Every requirement starts NOT DONE. A missing row is a failure, never an unknown.
  const requirementRows = groupRows(evidence.requirements, "id");
  let requirementsPassing = 0;
  for (const req of reqs.requirements) {
    const problem = judgeRow(requirementRows.get(req.id), packageHash, "no evidence row for this requirement");
    if (problem) fail(problem.kind, req.id, problem.why, req.gate);
    else requirementsPassing++;
  }

  // Every claimed platform needs its own passing row, judged by the same rules.
  const platformRows = groupRows(evidence.platform_evidence, "platform");
  let platformsPassing = 0;
  for (const plat of claimed) {
    const problem = judgeRow(platformRows.get(plat), packageHash, "platform is claimed but has no evidence row");
    if (problem) fail(problem.kind, `PLATFORM.${plat}`, problem.why);
    else platformsPassing++;
  }

  // Most severe first. One id fails once: counting it twice would make the
  // number lie just as surely as counting a pass that did not happen.
  const rank = (k) => {
    const i = KIND_ORDER.indexOf(k);
    return i === -1 ? KIND_ORDER.length : i;
  };
  failures.sort((a, b) => rank(a.kind) - rank(b.kind));
  const seen = new Set();
  const unique = failures.filter((f) => !seen.has(f.id) && seen.add(f.id));

  return {
    name: typeof evidence.name === "string" && evidence.name.trim() ? evidence.name.trim() : "(unnamed)",
    version: isAbsent(rel.version) ? null : String(rel.version),
    package_sha256: packageHash,
    verdict: unique.length === 0 ? "DONE" : "NOT DONE",
    counts: {
      requirements: reqs.requirements.length,
      requirements_passing: requirementsPassing,
      platforms: claimed.length,
      platforms_passing: platformsPassing,
      failures: unique.length,
    },
    failures: unique,
  };
}

// "REL-1.1" -> "REL-": leading letters and digits up to and including the
// first separator. IDs with no such prefix take no part in the unknown-ID scan.
function idPrefix(id) {
  const m = /^[A-Za-z][A-Za-z0-9]*[-_.:/]/.exec(id);
  return m ? m[0] : null;
}

/**
 * Check that a document cites every requirement ID, and cites no other ID
 * that shares a declared ID's prefix. IDs match as whole tokens, so REL-1.1
 * is not found inside REL-1.10.
 * Returns { requirements, missing[], unknown[] }.
 */
export function checkDocument(text, requirements) {
  const ids = normalizeRequirements(requirements).requirements.map((r) => r.id);
  const mention = (id) =>
    new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(id)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])`, "g");
  const doc = String(text);
  const missing = ids.filter((id) => !mention(id).test(doc));

  // Blank out every declared ID, then look for anything left that shares a prefix.
  let rest = doc;
  for (const id of [...ids].sort((a, b) => b.length - a.length)) rest = rest.replace(mention(id), " ");
  const unknown = new Set();
  for (const prefix of new Set(ids.map(idPrefix).filter(Boolean))) {
    const token = new RegExp(
      `(?<![A-Za-z0-9_.-])${escapeRegExp(prefix)}[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?`,
      "g",
    );
    for (const m of rest.matchAll(token)) unknown.add(m[0]);
  }
  return { requirements: ids.length, missing, unknown: [...unknown] };
}

// ---------------------------------------------------------------- CLI

const USAGE = `usage:
  done-gate <evidence.json> [--requirements <file>] [--json]
  done-gate --all <dir> [--requirements <file>] [--json]
  done-gate --check-doc <doc.md> [--requirements <file>] [--json]
  done-gate hash <file>
  done-gate init

--requirements defaults to ./requirements.json, then the bundled example.
Exit codes: 0 DONE, 1 NOT DONE, 2 usage or I/O error (also NOT DONE).`;

const STARTER_REQUIREMENTS = {
  release_identity_fields: DEFAULT_IDENTITY_FIELDS,
  requirements: [
    { id: "REL-1", text: "The package installs on a clean machine with no developer tools." },
    { id: "REL-2", text: "Every advertised feature works end to end from the installed package." },
    { id: "REL-3", text: "Updating from the previous release keeps user data and settings." },
  ],
};

const STARTER_EVIDENCE = {
  name: "my-app",
  release: {
    version: "0.1.0",
    commit: "",
    package_path: "dist/my-app-0.1.0.zip",
    package_sha256: "",
    platforms: ["linux"],
    source_clean: null,
  },
  requirements: STARTER_REQUIREMENTS.requirements.map(({ id }) => ({
    id,
    status: "unverified",
    evidence: "",
    artifact_sha256: "",
  })),
  platform_evidence: [{ platform: "linux", status: "unverified", evidence: "", artifact_sha256: "" }],
};

function readJSON(file, what) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(
      err.code === "ENOENT" ? `${what} not found: ${displayPath(file)}` : `cannot read ${what} ${displayPath(file)}: ${err.message}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${what} is not valid JSON (${displayPath(file)}): ${err.message}`);
  }
}

function parseArgs(argv) {
  const o = { json: false, help: false, version: false, requirements: null, all: null, checkDoc: null, evidence: null };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    if (arg.startsWith("--") && arg.includes("=")) {
      value = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    const take = () => {
      if (value !== undefined) return value;
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      return argv[++i];
    };
    const flag = () => {
      if (value !== undefined) throw new UsageError(`${arg} takes no value`);
      return true;
    };
    switch (arg) {
      case "--json": o.json = flag(); break;
      case "--help": case "-h": o.help = flag(); break;
      case "--version": case "-v": o.version = flag(); break;
      case "--requirements": o.requirements = take(); break;
      case "--all": o.all = take(); break;
      case "--check-doc": o.checkDoc = take(); break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}\n${USAGE}`);
        if (o.evidence !== null) throw new UsageError("one evidence file per run; use --all <dir> for several");
        o.evidence = arg;
    }
  }
  return o;
}

function resolveRequirements(flag) {
  if (flag !== null) return { file: path.resolve(flag), bundled: false };
  const local = path.resolve("requirements.json");
  if (existsSync(local)) return { file: local, bundled: false };
  return { file: BUNDLED_REQUIREMENTS, bundled: true };
}

function judgeFile(evidencePath, requirements, source) {
  const evidence = readJSON(evidencePath, "evidence file");
  let v;
  try {
    v = judge(evidence, requirements, { baseDir: path.dirname(evidencePath) });
  } catch (err) {
    if (err instanceof UsageError) throw new UsageError(`${displayPath(evidencePath)}: ${err.message}`);
    throw err;
  }
  return {
    name: v.name,
    version: v.version,
    verdict: v.verdict,
    evidence_file: displayPath(evidencePath),
    requirements_file: displayPath(source.file),
    requirements_bundled: source.bundled,
    package_sha256: v.package_sha256,
    counts: v.counts,
    failures: v.failures,
  };
}

function printReport(v) {
  const c = v.counts;
  console.log(`${[v.name, v.version].filter(Boolean).join(" ")}  ->  ${v.verdict}`);
  console.log(`  evidence      ${v.evidence_file}`);
  console.log(`  requirements  ${v.requirements_file}${v.requirements_bundled ? " (bundled example)" : ""}`);
  console.log(`  package       ${v.package_sha256 ?? "(no valid package_sha256)"}`);
  console.log(`  passing       ${c.requirements_passing}/${c.requirements} requirements, ${c.platforms_passing}/${c.platforms} platforms`);
  const groups = new Map();
  for (const f of v.failures) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
  for (const [kind, list] of groups) {
    console.log(`  ${kind.toUpperCase()} (${list.length})`);
    const shown = list.slice(0, SHOW_PER_KIND);
    const width = Math.min(20, Math.max(...shown.map((f) => f.id.length)));
    for (const f of shown) console.log(`    ${f.id.padEnd(width)}  ${f.why}`);
    if (list.length > SHOW_PER_KIND) console.log(`    ... and ${list.length - SHOW_PER_KIND} more (--json lists all)`);
  }
}

function cmdOne(file, requirements, source, asJSON) {
  const v = judgeFile(path.resolve(file), requirements, source);
  if (asJSON) console.log(JSON.stringify(v, null, 2));
  else printReport(v);
  return v.verdict === "DONE" ? 0 : 1;
}

function cmdAll(dir, requirements, source, asJSON) {
  const root = path.resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`--all needs an existing directory: ${dir}`);
  // Skip the requirements file itself if it lives in the same directory.
  const requirementsReal = existsSync(source.file) ? realpathSync(source.file) : null;
  const files = readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(root, f))
    .filter((f) => statSync(f).isFile() && realpathSync(f) !== requirementsReal);
  const results = files.map((f) => judgeFile(f, requirements, source));
  const done = results.filter((r) => r.verdict === "DONE").length;
  const verdict = results.length > 0 && done === results.length ? "DONE" : "NOT DONE";
  if (asJSON) {
    console.log(JSON.stringify({ verdict, done, total: results.length, releases: results }, null, 2));
  } else if (results.length === 0) {
    console.error(`done-gate: no evidence files in ${displayPath(root)}; NOT DONE by absence`);
  } else {
    results.forEach((r, i) => {
      if (i) console.log("");
      printReport(r);
    });
    console.log("");
    console.log(`ALL  ->  ${verdict}  (${done} of ${results.length} releases DONE)`);
  }
  return verdict === "DONE" ? 0 : 1;
}

function cmdCheckDoc(file, requirements, source, asJSON) {
  const docPath = path.resolve(file);
  let text;
  try {
    text = readFileSync(docPath, "utf8");
  } catch (err) {
    throw new UsageError(err.code === "ENOENT" ? `document not found: ${file}` : `cannot read ${file}: ${err.message}`);
  }
  const r = checkDocument(text, requirements);
  const ok = r.missing.length === 0 && r.unknown.length === 0;
  const doc = displayPath(docPath);
  const reqFile = displayPath(source.file);
  if (asJSON) {
    console.log(JSON.stringify({ document: doc, requirements_file: reqFile, ok, ...r }, null, 2));
  } else if (ok) {
    console.log(`done-gate: ${doc} cites all ${r.requirements} requirement IDs in ${reqFile} and no unknown ones`);
  } else {
    if (r.missing.length) {
      console.error(`done-gate: ${doc} is missing ${r.missing.length} requirement ID(s): ${r.missing.join(", ")}`);
    }
    if (r.unknown.length) {
      console.error(`done-gate: ${doc} cites ${r.unknown.length} ID(s) not declared in ${reqFile}: ${r.unknown.join(", ")}`);
    }
  }
  return ok ? 0 : 1;
}

function cmdHash(args) {
  if (args.length !== 1 || args[0].startsWith("-")) throw new UsageError("usage: done-gate hash <file>");
  try {
    console.log(hashFile(path.resolve(args[0])));
  } catch (err) {
    if (err.code === "ENOENT") throw new UsageError(`file not found: ${args[0]}`);
    if (err.code === "ENOTFILE") throw new UsageError(`not a regular file: ${args[0]}`);
    throw new UsageError(`cannot hash ${args[0]}: ${err.message}`);
  }
  return 0;
}

function cmdInit(args) {
  if (args.length) throw new UsageError("init takes no arguments; it writes into the current directory");
  const targets = ["requirements.json", "evidence.json"].map((f) => path.resolve(f));
  const existing = targets.filter((f) => existsSync(f));
  if (existing.length) {
    throw new UsageError(`refusing to overwrite ${existing.map((f) => path.basename(f)).join(" and ")}; nothing was written`);
  }
  writeFileSync(targets[0], `${JSON.stringify(STARTER_REQUIREMENTS, null, 2)}\n`, { flag: "wx" });
  writeFileSync(targets[1], `${JSON.stringify(STARTER_EVIDENCE, null, 2)}\n`, { flag: "wx" });
  console.log(`done-gate: wrote requirements.json and evidence.json
next:
  1. List what "done" means for your release in requirements.json.
  2. Build your package and record its hash: done-gate hash <package>
  3. Put that hash in release.package_sha256 and in every row you verify.
  4. Run: done-gate evidence.json
The template is NOT DONE until you fill it in. That is on purpose.`);
  return 0;
}

function main(argv) {
  if (argv[0] === "hash") return cmdHash(argv.slice(1));
  if (argv[0] === "init") return cmdInit(argv.slice(1));
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(readJSON(path.join(ROOT, "package.json"), "package.json").version);
    return 0;
  }
  const modes = [opts.evidence, opts.all, opts.checkDoc].filter((m) => m !== null).length;
  if (modes === 0) throw new UsageError(`nothing to judge\n${USAGE}`);
  if (modes > 1) throw new UsageError("give one of <evidence.json>, --all <dir> or --check-doc <doc.md>");

  const source = resolveRequirements(opts.requirements);
  const requirements = readJSON(source.file, "requirements file");
  try {
    normalizeRequirements(requirements);
  } catch (err) {
    if (err instanceof UsageError) throw new UsageError(`${displayPath(source.file)}: ${err.message}`);
    throw err;
  }

  if (opts.checkDoc !== null) return cmdCheckDoc(opts.checkDoc, requirements, source, opts.json);
  if (opts.all !== null) return cmdAll(opts.all, requirements, source, opts.json);
  return cmdOne(opts.evidence, requirements, source, opts.json);
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === SCRIPT;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    // exitCode, not process.exit(): a piped stdout must be flushed first.
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`done-gate: ${err instanceof UsageError ? err.message : err.stack}`);
    process.exitCode = 2;
  }
}
