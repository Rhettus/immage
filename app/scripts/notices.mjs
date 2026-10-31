// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the license notices of the Rust crates and npm packages compiled into
// the app, which their MIT, BSD and Apache licenses require to travel with
// the binaries. run before every build (tauri.conf.json's beforeBuildCommand
// and beforeDevCommand): the crates come from `cargo metadata` for the
// machine building, the packages from package-lock.json, and each one's
// texts from the files it ships. writes src-tauri/resources/notices.txt,
// which Preferences' About shows
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(app, "src-tauri", "resources", "notices.txt");
const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)/i;

// a package's license texts: the files named so in its root, and the one
// its manifest names
function texts(dir, named) {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    : [];
  if (named && !files.includes(named) && existsSync(join(dir, named))) files.push(named);
  return files.sort().map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim());
}

// the crates the app's binary is built from, on this platform: the normal
// dependencies reachable from the app, not build scripts' or tests'. path
// crates are Immage's own (the app, the importer's plugin)
function crates() {
  const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked",
    "--filter-platform", host, "--manifest-path", join(app, "src-tauri", "Cargo.toml")],
  { encoding: "utf8", maxBuffer: 256 << 20 }));
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set(), queue = [meta.resolve.root];
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id).deps)
      if (d.dep_kinds.some((k) => k.kind === null)) queue.push(d.pkg);
  }
  return [...seen].map((id) => byId.get(id)).filter((p) => p.source).map((p) => ({
    name: p.name, version: p.version, license: p.license ?? "unknown", authors: p.authors.join(", "),
    source: p.repository ?? `https://crates.io/crates/${p.name}`,
    texts: texts(dirname(p.manifest_path), p.license_file),
  }));
}

// the packages the front end is bundled from: the lockfile's, less those
// only the build uses
function packages() {
  const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([path, p]) => path && !p.dev && !p.devOptional && !p.link)
    .map(([path, p]) => {
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      let source = p.resolved ?? "";
      try {
        const repo = JSON.parse(readFileSync(join(app, path, "package.json"), "utf8")).repository;
        source = (typeof repo === "string" ? repo : repo?.url) ?? source;
      } catch { /* the lockfile's tarball will do */ }
      return { name, version: p.version, license: p.license ?? "unknown", authors: "", source, texts: texts(join(app, path)) };
    });
}

const groups = [["Rust crates", crates()], ["npm packages", packages()]];
// the same text (an Apache license, say) is printed once, under the first
// package that ships it, and the others point to it
const printed = new Map();
const index = [], bodies = [], bare = [];
// a package under one license alone, with one text: that license's text,
// for packages that ship none (objc2 and its family, for one)
const ids = (expr) => expr.split(/[\s()]+|\bOR\b|\bAND\b|\bWITH\b/).filter((x) => x && !/^(OR|AND|WITH)$/.test(x));
const canonical = new Map();
for (const [, list] of groups)
  for (const p of list)
    if (ids(p.license).length === 1 && p.texts.length === 1 && !canonical.has(p.license))
      canonical.set(p.license, `${p.name} ${p.version}`);
for (const [title, list] of groups) {
  list.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  index.push(`${title} (${list.length})\n`);
  for (const p of list) {
    const label = `${p.name} ${p.version}`;
    index.push(`${label}\n  license: ${p.license}\n  source: ${p.source}\n`);
    if (!p.texts.length) {
      const id = ids(p.license).find((x) => canonical.has(x));
      if (id) bodies.push(`== ${label}: ships no license file; under ${id}, whose text is as ${canonical.get(id)}`
                          + `${p.authors ? `, copyright ${p.authors}` : ""}\n`);
      else bare.push(label);
    }
    for (const t of p.texts) {
      const key = createHash("sha256").update(t).digest("hex");
      if (printed.has(key)) { bodies.push(`== ${label}: as ${printed.get(key)}\n`); continue; }
      printed.set(key, label);
      bodies.push(`== ${label}\n\n${t}\n`);
    }
  }
  index.push("");
}
// Immporter, a path crate and so left out of crates(), is Immage's own but
// lives in its own repository: name the commit app/immporter.rev pins
const immporter = readFileSync(join(app, "immporter.rev"), "utf8").trim().split(/\s/)[0];
mkdirSync(dirname(out), { recursive: true });
const webkitNotice = join(app, "..", "build", "webkitgtk", "install", "usr", "share", "doc", "immage-webkitgtk", "NOTICE");
writeFileSync(out,
  "Rust crates and npm packages compiled into Immage. Each keeps its own license;\n"
  + "the texts they ship follow the list.\n\n"
  + "Immporter, Immage's SD card importer\n  license: GPL-3.0-or-later, as Immage\n"
  + `  source: https://github.com/Rhettus/immporter/tree/${immporter}\n\n`
  + index.join("\n") + "\n" + bodies.join("\n")
  + (process.platform === "linux" && existsSync(webkitNotice) ? "\n\n" + readFileSync(webkitNotice, "utf8") : ""));
const n = groups.reduce((s, [, l]) => s + l.length, 0);
console.log(`notices for ${n} packages, ${Math.round(statSync(out).size / 1024)} KB; no license file: ${bare.join(", ") || "none"}`);
