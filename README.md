# done-gate

A fail-closed release verdict. A requirement counts only when its evidence names the SHA-256 of the exact package you ship.

```text
$ done-gate hash examples/example-app-1.0.0.txt
2a2514a1b05529289fe0c5be6e088a09cc39c479c410327a1bfd427848c8a499

$ done-gate examples/evidence.stale.json
example-app 1.0.0  ->  NOT DONE
  evidence      examples/evidence.stale.json
  requirements  examples/requirements.desktop-app.json (bundled example)
  package       2a2514a1b05529289fe0c5be6e088a09cc39c479c410327a1bfd427848c8a499
  passing       2/72 requirements, 0/2 platforms
  STALE (72)
    REL-1.1  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-1.2  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-1.3  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-1.4  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-1.5  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-1.6  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-2.2  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-2.3  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-2.4  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-2.5  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-3.1  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    REL-3.2  gathered against 6131e097f1bc..., not the current package 2a2514a1b055...
    ... and 60 more (--json lists all)
$ echo $?
1
```

Every row in that file says `"status": "pass"`. Version 1.0.0 was rebuilt, and the new bytes have a new hash. Two rows were checked again against the new package. The other 70, and both platform rows, were recorded against the old build, so they no longer count. `examples/evidence.pass.json` is the same release with every row checked against the current package. It is DONE.

## Why

A status table said nine apps were notarized. Live checks found two. The table had sources, and it was still wrong, because nothing tied each claim to the bytes that shipped.

The same night, a rebuild produced different bytes under the same build number. Customers already on that number would never be offered the fix.

Tables that aren't bound to an artifact stay wrong. done-gate binds every claim to the SHA-256 of the package it was checked against. When the package changes, every old claim goes stale by itself. Nobody has to remember to re-check. Forgetting is the default, so forgetting has to fail.

## Usage

Needs Node.js 20 or newer. No dependencies.

```sh
npx github:mthburnsbarber-web/done-gate init                # starter requirements.json and evidence.json
npx github:mthburnsbarber-web/done-gate hash dist/app.zip   # the SHA-256 to record
npx github:mthburnsbarber-web/done-gate evidence.json       # the verdict
```

| Command | What it does |
|---|---|
| `done-gate <evidence.json>` | Judge one release. |
| `done-gate --all <dir>` | Judge every `*.json` in a directory, except the requirements file. DONE only if every release is DONE. An empty directory is NOT DONE. |
| `done-gate --check-doc <file.md>` | Check that a document cites every requirement ID and no unknown ones. |
| `done-gate hash <file>` | Print a file's SHA-256. |
| `done-gate init` | Write a starter `requirements.json` and `evidence.json` into the current directory. Refuses to overwrite either file. The starter is NOT DONE until you fill it in. |

| Option | Meaning |
|---|---|
| `--requirements <file>` | The requirements to judge against. Default: `./requirements.json`, then the bundled `examples/requirements.desktop-app.json`. The report names the file it used. |
| `--json` | Print the result as JSON. The exit code does not change. |

Exit codes: `0` DONE, `1` NOT DONE, `2` usage or I/O error. A `2` is also NOT DONE.

### How a release is judged

1. Every requirement starts NOT DONE. A missing row fails.
2. Only the exact string `"pass"` passes. `"PASS"`, `"passed"`, `"ok"` and `"n/a"` all fail. If a requirement does not apply to you, remove it from your requirements file.
3. A pass with no evidence text fails. An assertion is not evidence.
4. Every row names the `artifact_sha256` it was checked against. If that is not the release's `package_sha256`, the row is STALE. A rebuild makes every old row stale.
5. If `package_path` is set, the file must exist, and its real SHA-256 is computed and compared with `package_sha256`. A package that changed after the evidence was recorded fails.
6. `source_clean` must be `true`. A dirty tree means the package cannot be rebuilt from the recorded commit.
7. Every platform in `platforms` needs its own row in `platform_evidence`, judged by rules 2 to 4.
8. Two rows for one requirement fail. A requirements file with no requirements, or with a duplicate ID, is a usage error.

It never fails open. A missing file, bad JSON, an unreadable package or an unknown status all end in NOT DONE.

### Checking a document

Teams often keep the requirements as prose too, in a release checklist or a standard. `--check-doc` keeps the prose and the enforced list from drifting apart. It passes when the document:

- cites every requirement ID in the requirements file, and
- cites no other ID that shares a declared ID's prefix.

The prefix is the leading letters and digits of an ID, up to and including the first `-`, `_`, `.`, `:` or `/`. `REL-1.1` has the prefix `REL-`, so a stray `REL-9.9` in the document fails the check. IDs are matched as whole tokens: `REL-1.10` is not a mention of `REL-1.1`. Matching is case-sensitive. An ID with no such prefix, such as `42`, is only checked for presence.

## Evidence format

One evidence file per release. A relative `package_path` resolves from the evidence file's directory.

```json
{
  "name": "example-app",
  "release": {
    "version": "1.0.0",
    "commit": "4e7f2a1",
    "package_path": "example-app-1.0.0.txt",
    "package_sha256": "2a2514a1b05529289fe0c5be6e088a09cc39c479c410327a1bfd427848c8a499",
    "platforms": ["macos", "windows"],
    "source_clean": true
  },
  "requirements": [
    { "id": "REL-1.1", "status": "pass", "evidence": "Checked on the installed package. Notes: reports/1.0.0/REL-1.1.md", "artifact_sha256": "2a2514a1b05529289fe0c5be6e088a09cc39c479c410327a1bfd427848c8a499" }
  ],
  "platform_evidence": [
    { "platform": "macos", "status": "pass", "evidence": "Installed and run on macOS 14 (Apple silicon) and macOS 13 (Intel).", "artifact_sha256": "2a2514a1b05529289fe0c5be6e088a09cc39c479c410327a1bfd427848c8a499" }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `name` | string | Shown in the report. |
| `release.version` | string | Required by default. Shown in the report. |
| `release.commit` | string | Required by default. |
| `release.package_path` | string | Required by default. The file must exist and hash to `package_sha256`. |
| `release.package_sha256` | 64 hex chars | Always required. Every row must name this hash. |
| `release.platforms` | string[] | Required by default. Each platform needs a passing `platform_evidence` row. |
| `release.source_clean` | boolean | Required by default. Must be `true`. |
| `requirements[]` | `{id, status, evidence, artifact_sha256}` | Exactly one row per requirement ID. An optional `why` is shown when a row fails. |
| `platform_evidence[]` | `{platform, status, evidence, artifact_sha256}` | Exactly one row per claimed platform. |

"Required by default" means the field is in the default `release_identity_fields`. Set that list in your requirements file to change it.

Status values other than `"pass"` are reported by name if they are one of `fail`, `missing`, `stale`, `blocked`, `skipped`, `unverified` or `n/a`. Anything else is reported as `invalid-status`. All of them fail.

The requirements file:

| Field | Rule |
|---|---|
| `gates[]` | Groups: `{ "name": "...", "requirements": [{ "id": "...", "text": "..." }] }`. |
| `requirements[]` | Ungrouped `{ "id", "text" }` entries. Use either form, or both. |
| `release_identity_fields` | Release fields that must be present and non-empty. Default: `version`, `commit`, `package_path`, `package_sha256`, `platforms`, `source_clean`. `package_sha256` is required even if you leave it out. |

IDs are free-form strings. `REL-1.1`, `SEC-AUTH-3` and `installs cleanly` all work.

`examples/requirements.desktop-app.json` has 72 product-quality gates for a desktop app: completeness, packaging, onboarding, fallbacks, layout, reliability, performance, security, data integrity, documentation and adversarial testing. Copy it and cut it down to what you ship.

## In CI

Run done-gate as the last step before you publish. A NOT DONE exits non-zero, so the job fails.

```yaml
jobs:
  release-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      # Put the exact package you tested at the path named in evidence.json.
      - run: ./scripts/fetch-release-package.sh
      - name: done-gate
        run: npx github:mthburnsbarber-web/done-gate evidence.json
```

To pin a version, append `#<tag or commit>` to the package spec.

The package in `package_path` must be in the job, byte for byte the one you tested. If CI rebuilds it and the build is not reproducible, the hash changes and every row goes STALE. That is the point.

## What it doesn't do

- It does not gather evidence or run your tests. You record the evidence; done-gate judges it.
- It cannot tell whether evidence text is true. It only refuses claims that are missing, malformed, or not bound to the bytes being shipped.
- It does not sign anything. The evidence file is plain JSON, and anyone who can edit it can edit the hashes. Review it like code.

## License

MIT
