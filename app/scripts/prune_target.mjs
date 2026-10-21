#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// remove what cargo leaves behind in app/src-tauri/target and never removes
// itself: libraries, object files, executables and build script output of
// earlier builds. every rebuild of a crate gets a new hash in its file
// names and leaves the old files where they were, so the folder grows by
// gigabytes a day (on macOS the dev profile also keeps every build's .rcgu.o
// for the debugger).
//
//   node app/scripts/prune_target.mjs [-n] [builds]
//
// keeps what the last <builds> builds of each profile used (default 2); -n
// lists what would go and removes nothing. npm runs it before and after
// every `npm run tauri ...` (package.json), and not in CI.
//
// which files a build uses only cargo knows: crates come in several
// versions and configurations at once, which their file names cannot tell
// apart. so after a build, each profile's build is asked again, as tauri
// runs it, with --message-format=json, which lists every file it uses: a
// second's work when it is up to date. one that is not is stopped at its
// first compile and left alone until its next build. the lists of the last
// <builds> builds are kept in target/<profile>/.prune.json
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI) process.exit(0);

const args = process.argv.slice(2);
const dry = args[0] === "-n";
if (dry) args.shift();
const keep = Number(args[0] ?? 2);
if (!Number.isInteger(keep) || keep < 1) {
  console.error("usage: prune_target.mjs [-n] [builds]");
  process.exit(2);
}

const crate = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const target = join(crate, "target");
const DAY = 86400e3;

// the cargo commands tauri runs (`tauri dev -v`, `tauri build -v`), and
// what it sets in their environment that build scripts watch: a build
// asked for with anything else is not the same build, and recompiles
const conf = JSON.parse(readFileSync(join(crate, "tauri.conf.json"), "utf8"));
const TAURI_ENV = {
  TAURI_CLI_VERBOSITY: "0",
  ...(conf.plugins?.updater ? { TAURI_UPDATER_PLUGIN_CONFIG: JSON.stringify(conf.plugins.updater) } : {}),
};
const MIN_MACOS = process.platform === "darwin" ? conf.bundle?.macOS?.minimumSystemVersion : undefined;
const PROFILES = {
  debug: { args: ["build", "--bins", "--no-default-features"], env: TAURI_ENV },
  // only tauri build sets the macOS deployment target, which objc2 and
  // everything after it rebuild for
  release: { args: ["build", "--bins", "--features", "tauri/custom-protocol", "--release"],
             env: { ...TAURI_ENV, ...(MIN_MACOS ? { MACOSX_DEPLOYMENT_TARGET: MIN_MACOS } : {}) } },
};

// the hashes of every unit the profile's build uses, or null when it is
// not up to date
function used({ args: cargoArgs, env }) {
  return new Promise((resolve) => {
    const p = spawn("cargo", [...cargoArgs, "--message-format=json"],
                    { cwd: crate, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] });
    const hashes = new Set(), bins = [];
    let stale = false;
    // a build script is build/<crate>-<hash>/build-script-build: the hash
    // is its folder's
    const hash = (path) => /-([0-9a-f]{16})(?:\.|$)/.exec(basename(path))?.[1]
      ?? /-([0-9a-f]{16})$/.exec(basename(dirname(path)))?.[1];
    createInterface({ input: p.stdout }).on("line", (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.reason === "compiler-artifact") {
        if (!m.fresh) { stale = true; p.kill(); }
        for (const f of m.filenames ?? []) { const h = hash(f); if (h) hashes.add(h); }
        // a binary comes as target/<profile>/<name>, a copy (or a hard link)
        // of deps/<name>-<hash>, which is found by its size
        if (m.executable && !hash(m.executable)) bins.push(m.executable);
      } else if (m.reason === "build-script-executed") {
        const h = hash(m.out_dir.replace(/[/\\]out$/, ""));
        if (h) hashes.add(h);
      }
    });
    p.on("close", (code) => {
      if (stale || (code !== 0 && code !== null)) return resolve(null);
      for (const bin of bins) {
        const st = statSync(bin, { throwIfNoEntry: false });
        if (!st) continue;
        const deps = join(dirname(bin), "deps");
        const name = basename(bin).replace(/\.exe$/, "").replaceAll("-", "_");
        const copies = readdirSync(deps).filter((f) => new RegExp(`^${name}-[0-9a-f]{16}(\\.exe)?$`).test(f))
          .map((f) => ({ f, st: statSync(join(deps, f)) })).filter((c) => c.st.size === st.size)
          .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
        if (copies.length) hashes.add(hash(copies[0].f));
      }
      resolve(hashes);
    });
    p.on("error", () => resolve(null));
  });
}

function size(path) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((s, e) => s + size(join(path, e)), 0);
}

const remove = [];
for (const [profile, build] of Object.entries(PROFILES)) {
  const dir = join(target, profile);
  if (!existsSync(join(dir, "deps"))) continue;
  const record = join(dir, ".prune.json");
  let builds = [];
  try { builds = JSON.parse(readFileSync(record, "utf8")); } catch { /* none yet */ }
  // cargo is asked only after a build, when the app's binary is newer than
  // the last list: the profile is then up to date, and nothing compiles.
  // otherwise the lists kept say what to keep
  const bin = join(dir, process.platform === "win32" ? "immage.exe" : "immage");
  const built = statSync(bin, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (built > Date.parse(builds.at(-1)?.at ?? 0)) {
    const now = await used(build);
    if (now) {
      const list = [...now].sort();
      if (JSON.stringify(builds.at(-1)?.hashes) !== JSON.stringify(list)) builds.push({ at: new Date().toISOString(), hashes: list });
      else builds.at(-1).at = new Date().toISOString();
      builds = builds.slice(-keep);
      if (!dry) writeFileSync(record, JSON.stringify(builds));
    }
  }
  if (!builds.length) {
    console.log(`prune_target: ${profile} is not up to date; left as it is until its next build`);
    continue;
  }
  const live = new Set(builds.flatMap((b) => b.hashes));

  // deps: <crate>-<16 hex>[.…] and lib<crate>-<16 hex>.<ext>. a hash with
  // only metadata is rust-analyzer's or clippy's check, which no build lists:
  // kept for a week, so the editor doesn't check everything again
  const groups = new Map();
  for (const f of readdirSync(join(dir, "deps"))) {
    const h = /-([0-9a-f]{16})(?:\.|$)/.exec(f)?.[1];
    if (!h || live.has(h)) continue;
    groups.set(h, [...(groups.get(h) ?? []), join(dir, "deps", f)]);
  }
  for (const files of groups.values()) {
    const check = files.every((f) => /\.(rmeta|d)$/.test(f));
    if (check && files.some((f) => Date.now() - statSync(f).mtimeMs < 7 * DAY)) continue;
    remove.push(...files);
  }
  // build: <crate>-<16 hex>, a build script and its output
  if (existsSync(join(dir, "build")))
    for (const f of readdirSync(join(dir, "build"))) {
      const h = /-([0-9a-f]{16})$/.exec(f)?.[1];
      if (h && !live.has(h)) remove.push(join(dir, "build", f));
    }
  // incremental: rustc's caches of the app's own crates, named by another
  // hash; cargo uses the ones it touched last
  if (existsSync(join(dir, "incremental")))
    for (const f of readdirSync(join(dir, "incremental"))) {
      const path = join(dir, "incremental", f);
      if (Date.now() - statSync(path).mtimeMs > 3 * DAY) remove.push(path);
    }
}

const mb = (b) => Math.round(b / 1e6);
const sizes = remove.map((p) => [p, size(p)]);
const total = sizes.reduce((s, [, n]) => s + n, 0);
if (dry) {
  for (const [p, n] of sizes) console.log(`${String(mb(n)).padStart(6)} MB  ${p}`);
  console.log(`would free ${mb(total)} MB`);
} else {
  for (const p of remove) rmSync(p, { recursive: true, force: true });
  if (total > 1e6) console.log(`prune_target: freed ${mb(total)} MB of earlier builds`);
}
