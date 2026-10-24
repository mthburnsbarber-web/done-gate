// Every test spawns the real CLI and checks its exit code and output.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "done-gate.mjs");
const EXAMPLES = path.join(ROOT, "examples");
const ARTIFACT = "example-app-1.0.0.txt";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "done-gate-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// A scratch copy of examples/ with the example requirements as ./requirements.json.
function workspace() {
  const dir = tempDir();
  cpSync(EXAMPLES, dir, { recursive: true });
  copyFileSync(path.join(dir, "requirements.desktop-app.json"), path.join(dir, "requirements.json"));
  return dir;
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function edit(file, change) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  change(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const row = (json, id) => json.requirements.find((r) => r.id === id);

test("bundled pass example is DONE (exit 0)", () => {
  const r = run(["examples/evidence.pass.json"], ROOT);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /example-app 1\.0\.0 {2}-> {2}DONE/);
  assert.match(r.out, /72\/72 requirements, 2\/2 platforms/);
  assert.match(r.out, /\(bundled example\)/);
});

test("bundled stale example is NOT DONE with STALE rows (exit 1)", () => {
  const r = run(["examples/evidence.stale.json"], ROOT);
  assert.equal(r.code, 1);
  assert.match(r.out, /-> {2}NOT DONE/);
  assert.match(r.out, /STALE \(72\)/);
  assert.match(r.out, /REL-1\.1 +gathered against 6131e097f1bc\.\.\., not the current package 2a2514a1b055\.\.\./);
  assert.match(r.out, /2\/72 requirements, 0\/2 platforms/);
});

test("a missing row fails", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    j.requirements = j.requirements.filter((r) => r.id !== "REL-4.2");
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /MISSING \(1\)\n {4}REL-4\.2 +no evidence row for this requirement/);
});

test("any status other than exactly \"pass\" fails", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    row(j, "REL-1.1").status = "passed";
    row(j, "REL-1.2").status = "PASS";
    row(j, "REL-1.3").status = "n/a";
    delete row(j, "REL-1.4").status;
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /INVALID-STATUS \(3\)/);
  assert.match(r.out, /REL-1\.1 +status "passed" is not "pass"/);
  assert.match(r.out, /REL-1\.2 +status "PASS" is not "pass"/);
  assert.match(r.out, /REL-1\.4 +status is missing/);
  assert.match(r.out, /N\/A \(1\)\n {4}REL-1\.3 +status "n\/a"/);
});

test("a pass with no evidence text fails", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    row(j, "REL-7.3").evidence = "   ";
    delete row(j, "REL-7.4").evidence;
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL \(2\)/);
  assert.match(r.out, /REL-7\.3 +status is "pass" but there is no evidence text; an assertion is not evidence/);
  assert.match(r.out, /REL-7\.4 +status is "pass" but there is no evidence text/);
});

test("a row with no artifact_sha256 is stale", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    delete row(j, "REL-9.1").artifact_sha256;
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /STALE \(1\)\n {4}REL-9\.1 +row names no artifact_sha256/);
});

test("rebuilding the artifact makes every old row stale", () => {
  const dir = workspace();
  const artifact = path.join(dir, ARTIFACT);
  const before = sha256(artifact);
  writeFileSync(artifact, readFileSync(artifact, "utf8").replace("(build 2)", "(build 3)"));
  const after = sha256(artifact);
  assert.notEqual(before, after);
  // The release now honestly names the new bytes; the rows still name the old ones.
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    j.release.package_sha256 = after;
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /0\/72 requirements, 0\/2 platforms/);
  assert.match(r.out, /STALE \(74\)/);
  assert.match(r.out, new RegExp(`gathered against ${before.slice(0, 12)}\\.\\.\\., not the current package ${after.slice(0, 12)}`));
});

test("a package that changed on disk after the evidence was recorded fails", () => {
  const dir = workspace();
  writeFileSync(path.join(dir, ARTIFACT), "tampered\n", { flag: "a" });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /IDENTITY \(1\)\n {4}RELEASE\.package_sha256 +package on disk hashes .* the package changed after the evidence was recorded/);
});

test("a package_path that does not exist fails", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    j.release.package_path = "dist/gone.zip";
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /RELEASE\.package_path +package not found/);
});

test("source_clean false fails reproducibility", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    j.release.source_clean = false;
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /RELEASE\.source_clean +source_clean is false, so the package cannot be reproduced/);
});

test("missing release identity fields fail", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    delete j.release.commit;
    j.release.package_sha256 = "not-a-hash";
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /RELEASE\.commit +release identity field is missing/);
  assert.match(r.out, /RELEASE\.package_sha256 +"not-a-hash" is not a SHA-256/);
});

test("a claimed platform with no passing platform evidence fails", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    j.release.platforms.push("linux");
    j.platform_evidence.find((p) => p.platform === "windows").status = "blocked";
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /1\/3 platforms/);
  assert.match(r.out, /MISSING \(1\)\n {4}PLATFORM\.linux +platform is claimed but has no evidence row/);
  assert.match(r.out, /BLOCKED \(1\)\n {4}PLATFORM\.windows +status "blocked"/);
});

test("two rows for one requirement fail", () => {
  const dir = workspace();
  edit(path.join(dir, "evidence.pass.json"), (j) => {
    j.requirements.push({ ...row(j, "REL-3.3"), status: "fail" });
  });
  const r = run(["evidence.pass.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /DUPLICATE \(1\)\n {4}REL-3\.3 +2 evidence rows; exactly one is allowed/);
});

test("--json prints the verdict and keeps the exit code", () => {
  const dir = workspace();
  const r = run(["evidence.stale.json", "--json"], dir);
  assert.equal(r.code, 1);
  const v = JSON.parse(r.out);
  assert.equal(v.verdict, "NOT DONE");
  assert.equal(v.counts.requirements, 72);
  assert.equal(v.counts.requirements_passing, 2);
  assert.equal(v.failures.length, 72);
  assert.ok(v.failures.every((f) => f.kind === "stale"));
  assert.equal(v.requirements_file, "requirements.json");
});

test("--requirements picks the file; a free-form ID set works", () => {
  const dir = tempDir();
  const pkg = path.join(dir, "app.tgz");
  writeFileSync(pkg, "bytes");
  const hash = sha256(pkg);
  writeFileSync(
    path.join(dir, "gates.json"),
    JSON.stringify({
      release_identity_fields: ["version"],
      requirements: [{ id: "installs cleanly" }, { id: "upgrade.keeps-data" }],
    }),
  );
  const pass = (id) => ({ id, status: "pass", evidence: "ran it", artifact_sha256: hash });
  writeFileSync(
    path.join(dir, "evidence.json"),
    JSON.stringify({
      name: "tiny",
      release: { version: "2.0.0", package_path: "app.tgz", package_sha256: hash },
      requirements: [pass("installs cleanly"), pass("upgrade.keeps-data")],
    }),
  );
  const r = run(["evidence.json", "--requirements", "gates.json"], dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /tiny 2\.0\.0 {2}-> {2}DONE/);
  assert.match(r.out, /requirements +gates\.json\n/);
});

test("--all is DONE only when every release is DONE", () => {
  const dir = workspace();
  const releases = path.join(dir, "releases");
  mkdirSync(releases);
  copyFileSync(path.join(dir, "evidence.pass.json"), path.join(releases, "a.json"));
  const evidence = (f) => edit(path.join(releases, f), (j) => {
    j.release.package_path = `../${ARTIFACT}`;
  });
  evidence("a.json");

  let r = run(["--all", "releases"], dir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /ALL {2}-> {2}DONE {2}\(1 of 1 releases DONE\)/);

  copyFileSync(path.join(dir, "evidence.stale.json"), path.join(releases, "b.json"));
  evidence("b.json");
  r = run(["--all", "releases"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /ALL {2}-> {2}NOT DONE {2}\(1 of 2 releases DONE\)/);

  r = run(["--all", "releases", "--json"], dir);
  assert.equal(r.code, 1);
  const v = JSON.parse(r.out);
  assert.deepEqual([v.verdict, v.done, v.total], ["NOT DONE", 1, 2]);
});

test("--all on an empty directory is NOT DONE by absence", () => {
  const dir = workspace();
  mkdirSync(path.join(dir, "empty"));
  const r = run(["--all", "empty"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /no evidence files .* NOT DONE by absence/);
});

test("--check-doc passes when a document cites exactly the declared IDs", () => {
  const dir = workspace();
  const reqs = JSON.parse(readFileSync(path.join(dir, "requirements.json"), "utf8"));
  const ids = reqs.gates.flatMap((g) => g.requirements.map((r) => r.id));
  writeFileSync(path.join(dir, "RELEASE.md"), `# Release checklist\n\n${ids.map((id) => `- ${id}.`).join("\n")}\n`);
  const r = run(["--check-doc", "RELEASE.md"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /cites all 72 requirement IDs/);
});

test("--check-doc reports missing and unknown IDs", () => {
  const dir = workspace();
  const reqs = JSON.parse(readFileSync(path.join(dir, "requirements.json"), "utf8"));
  // Drop REL-1.1 and REL-5.2. REL-1.10 must not count as a mention of REL-1.1,
  // and REL-9.99 / REL-13.1 are not declared.
  const ids = reqs.gates
    .flatMap((g) => g.requirements.map((r) => r.id))
    .filter((id) => id !== "REL-1.1" && id !== "REL-5.2");
  const doc = `${ids.join(", ")}\nSee also REL-1.10, REL-9.99 and (REL-13.1). PREL-7 and rel-1.1 are not IDs.\n`;
  writeFileSync(path.join(dir, "RELEASE.md"), doc);
  const r = run(["--check-doc", "RELEASE.md"], dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /is missing 2 requirement ID\(s\): REL-1\.1, REL-5\.2/);
  assert.match(r.err, /cites 3 ID\(s\) not declared in requirements\.json: REL-1\.10, REL-9\.99, REL-13\.1/);

  const j = run(["--check-doc", "RELEASE.md", "--json"], dir);
  assert.equal(j.code, 1);
  const v = JSON.parse(j.out);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["REL-1.1", "REL-5.2"]);
  assert.deepEqual(v.unknown, ["REL-1.10", "REL-9.99", "REL-13.1"]);
});

test("hash prints the file's SHA-256", () => {
  const r = run(["hash", path.join(EXAMPLES, ARTIFACT)], ROOT);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${sha256(path.join(EXAMPLES, ARTIFACT))}\n`);
  assert.equal(r.out.trim(), JSON.parse(readFileSync(path.join(EXAMPLES, "evidence.pass.json"), "utf8")).release.package_sha256);

  const missing = run(["hash", "no-such-file"], ROOT);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /file not found: no-such-file/);
});

test("init writes a starter that is NOT DONE, and refuses to overwrite", () => {
  const dir = tempDir();
  let r = run(["init"], dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /wrote requirements\.json and evidence\.json/);
  const reqsBefore = readFileSync(path.join(dir, "requirements.json"), "utf8");
  const evidenceBefore = readFileSync(path.join(dir, "evidence.json"), "utf8");
  assert.ok(JSON.parse(reqsBefore).requirements.length > 0);

  r = run(["evidence.json"], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /my-app 0\.1\.0 {2}-> {2}NOT DONE/);
  assert.match(r.out, /RELEASE\.package_sha256 +release identity field is missing/);

  r = run(["init"], dir);
  assert.equal(r.code, 2);
  assert.match(r.err, /refusing to overwrite requirements\.json and evidence\.json; nothing was written/);
  assert.equal(readFileSync(path.join(dir, "requirements.json"), "utf8"), reqsBefore);
  assert.equal(readFileSync(path.join(dir, "evidence.json"), "utf8"), evidenceBefore);

  // One existing file is enough to refuse; the other is not created.
  const other = tempDir();
  writeFileSync(path.join(other, "evidence.json"), "{}");
  r = run(["init"], other);
  assert.equal(r.code, 2);
  assert.match(r.err, /refusing to overwrite evidence\.json/);
  assert.throws(() => readFileSync(path.join(other, "requirements.json")), { code: "ENOENT" });
});

test("usage and I/O errors exit 2", () => {
  const dir = workspace();
  writeFileSync(path.join(dir, "broken.json"), "{ not json");
  writeFileSync(path.join(dir, "empty-reqs.json"), JSON.stringify({ requirements: [] }));
  writeFileSync(path.join(dir, "dupe-reqs.json"), JSON.stringify({ requirements: [{ id: "A-1" }, { id: "A-1" }] }));
  const cases = [
    [[], /nothing to judge/],
    [["--jsn", "evidence.pass.json"], /unknown option: --jsn/],
    [["no-such.json"], /evidence file not found: no-such\.json/],
    [["broken.json"], /evidence file is not valid JSON/],
    [["evidence.pass.json", "--requirements", "missing.json"], /requirements file not found: missing\.json/],
    [["evidence.pass.json", "--requirements", "empty-reqs.json"], /declares no requirements/],
    [["evidence.pass.json", "--requirements", "dupe-reqs.json"], /"A-1" is declared more than once/],
    [["evidence.pass.json", "evidence.stale.json"], /one evidence file per run/],
  ];
  for (const [args, pattern] of cases) {
    const r = run(args, dir);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}${r.err}`);
    assert.match(r.err, pattern);
  }
});

test("runs through an npm bin symlink from a path with spaces", { skip: process.platform === "win32" }, () => {
  // Lay out <tmp>/my project/node_modules the way npm does, then run the .bin link.
  const project = path.join(tempDir("done gate "), "my project");
  const pkg = path.join(project, "node_modules", "done-gate");
  const bin = path.join(project, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  cpSync(EXAMPLES, path.join(pkg, "examples"), { recursive: true });
  copyFileSync(path.join(ROOT, "package.json"), path.join(pkg, "package.json"));
  copyFileSync(CLI, path.join(pkg, "done-gate.mjs"));
  chmodSync(path.join(pkg, "done-gate.mjs"), 0o755);
  symlinkSync("../done-gate/done-gate.mjs", path.join(bin, "done-gate"));

  // The project has evidence but no requirements.json, so the bundled example is used.
  mkdirSync(path.join(project, "release files"));
  for (const f of ["evidence.pass.json", ARTIFACT]) {
    copyFileSync(path.join(EXAMPLES, f), path.join(project, "release files", f));
  }
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const r = spawnSync(path.join(bin, "done-gate"), ["release files/evidence.pass.json"], { cwd: project, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /-> {2}DONE/);
  assert.match(r.stdout, /requirements +node_modules\/done-gate\/examples\/requirements\.desktop-app\.json \(bundled example\)/);

  // Even when Node is told to keep the symlink path, the script finds its own files.
  const kept = spawnSync(
    process.execPath,
    ["--preserve-symlinks", "--preserve-symlinks-main", path.join(bin, "done-gate"), "release files/evidence.pass.json"],
    { cwd: project, encoding: "utf8" },
  );
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /node_modules\/done-gate\/examples\/requirements\.desktop-app\.json \(bundled example\)/);

  const v = spawnSync(path.join(bin, "done-gate"), ["--version"], { cwd: project, env, encoding: "utf8" });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
});
