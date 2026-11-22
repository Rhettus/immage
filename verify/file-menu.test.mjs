// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { transformSync } = await import(require.resolve("rolldown/experimental"));
const data = (source) => "data:text/javascript," + encodeURIComponent(source);

let mockImmichSettings = { enabled: false, url: "", hasKey: false };
globalThis.__mockGetImmichSettings = async () => mockImmichSettings;

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@immporter/api") {
      return {
        url: data("export const api = { getImmichSettings: () => globalThis.__mockGetImmichSettings(), getSettings: async () => null };"),
        shortCircuit: true,
      };
    }
    if (spec === "./commands" && ctx.parentURL?.endsWith("/immich.ts")) {
      return { url: data("export const commands = {};"), shortCircuit: true };
    }
    if (spec === "./tunerWorkload" && ctx.parentURL?.endsWith("/immich.ts")) {
      return { url: data("export const timeTunerWork = (_name, fn) => fn();"), shortCircuit: true };
    }
    if (spec === "./settings" && ctx.parentURL?.endsWith("/immich.ts")) {
      return { url: data("export const settings = { get: () => null, set: () => {} };"), shortCircuit: true };
    }
    if (spec.startsWith(".") && !/\.[jt]sx?$/.test(spec)) {
      for (const ext of [".ts", ".tsx"]) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url)) return next(url, ctx);
    return {
      format: "module",
      source: transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), "utf8")).code,
      shortCircuit: true,
    };
  },
});

const {
  showInLibraryTarget,
  canShowResultsMenu,
  immichMenuState,
  findTargetEntry,
} = await import("../app/src/fileMenuModel.ts");
const { immichUrl } = await import("../app/src/immich.ts");

test("showInLibraryTarget handles search results, subfolders, filmstrip, grid folder view, and remote results", () => {
  const roots = ["/home/user/Pictures/Photos"];

  // 1. Local photo during search (CLIP / All folders / filename)
  const hitLocal = { imgid: 10, path: "/home/user/Pictures/Photos/2026/photo.jpg", version: 0 };
  assert.deepEqual(
    showInLibraryTarget(hitLocal, { activeSearch: true, currentFolder: null, grid: true, roots }),
    { path: "/home/user/Pictures/Photos/2026/photo.jpg", dir: "/home/user/Pictures/Photos/2026", version: 0 },
  );

  // 2. Virtual copy preserves version
  const hitCopy = { imgid: 11, path: "/home/user/Pictures/Photos/2026/photo.jpg", version: 2 };
  assert.equal(
    showInLibraryTarget(hitCopy, { activeSearch: true, currentFolder: null, grid: true, roots })?.version,
    2,
  );

  // 3. Local photo in subfolder while browsing parent folder with subfolders enabled
  assert.deepEqual(
    showInLibraryTarget(hitLocal, {
      activeSearch: false,
      currentFolder: "/home/user/Pictures/Photos",
      grid: true,
      roots,
    }),
    { path: "/home/user/Pictures/Photos/2026/photo.jpg", dir: "/home/user/Pictures/Photos/2026", version: 0 },
  );

  // 4. Local photo from filmstrip (!grid, same folder)
  assert.notEqual(
    showInLibraryTarget(hitLocal, {
      activeSearch: false,
      currentFolder: "/home/user/Pictures/Photos/2026",
      grid: false,
      roots,
    }),
    null,
  );

  // 5. Already in Grid folder view for exact folder -> hidden
  assert.equal(
    showInLibraryTarget(hitLocal, {
      activeSearch: false,
      currentFolder: "/home/user/Pictures/Photos/2026",
      grid: true,
      roots,
    }),
    null,
  );

  // 6. Remote Immich result mapped inside a configured library root -> jump target
  const hitRemoteValid = {
    imgid: -1,
    path: "immich:/mnt/photos/2026/remote.jpg",
    remote: { localPath: "/home/user/Pictures/Photos/2026/remote.jpg", assetId: "a1" },
  };
  assert.deepEqual(
    showInLibraryTarget(hitRemoteValid, { activeSearch: true, currentFolder: null, grid: true, roots }),
    { path: "/home/user/Pictures/Photos/2026/remote.jpg", dir: "/home/user/Pictures/Photos/2026", version: 0 },
  );

  // 7. Remote Immich result outside library roots or unmapped -> hidden
  assert.equal(
    showInLibraryTarget(
      { imgid: -2, path: "immich:/other/remote.jpg", remote: { localPath: "/other/path/remote.jpg", assetId: "a2" } },
      { activeSearch: true, currentFolder: null, grid: true, roots },
    ),
    null,
  );
  assert.equal(
    showInLibraryTarget(
      { imgid: -3, path: "immich:/cloud/remote.jpg", remote: { localPath: null, assetId: "a3" } },
      { activeSearch: true, currentFolder: null, grid: true, roots },
    ),
    null,
  );
  assert.equal(showInLibraryTarget(null, { activeSearch: true, currentFolder: null, grid: true, roots }), null);
});

test("immichMenuState and canShowResultsMenu gate Immich items on configuration/enabled state and search source", () => {
  const photoUrlFn = (base, id) => `${base}/photos/${id}`;
  const searchUrlFn = (base, s) => `${base}/search?q=${s.query}`;

  // Immich not configured or disabled (immichBase === null)
  assert.equal(canShowResultsMenu(null, { source: "immich" }), false);
  assert.deepEqual(
    immichMenuState({
      immichBase: null,
      immichSearch: { source: "immich" },
      hit: { remote: { assetId: "123", localPath: "/tmp/a.jpg" } },
      photoUrl: photoUrlFn,
      searchUrl: searchUrlFn,
    }),
    { photo: null, results: null, parentFolder: undefined },
  );

  // Configured + enabled, but local-only search (CLIP / All folders)
  assert.equal(canShowResultsMenu("https://immich.local", { source: "local" }), false);
  const stateLocal = immichMenuState({
    immichBase: "https://immich.local",
    immichSearch: { source: "local" },
    hit: { remote: undefined },
    photoUrl: photoUrlFn,
    searchUrl: searchUrlFn,
  });
  assert.deepEqual(stateLocal, { photo: null, results: null, parentFolder: undefined });

  // Configured + enabled + "immich" or "both" search
  assert.equal(canShowResultsMenu("https://immich.local", { source: "immich", query: "test" }), true);
  assert.equal(canShowResultsMenu("https://immich.local", { source: "both", query: "test" }), true);
  assert.deepEqual(
    immichMenuState({
      immichBase: "https://immich.local",
      immichSearch: { source: "immich", query: "test" },
      hit: { remote: { assetId: "123", localPath: "/tmp/a.jpg" } },
      photoUrl: photoUrlFn,
      searchUrl: searchUrlFn,
    }),
    {
      photo: "https://immich.local/photos/123",
      results: "https://immich.local/search?q=test",
      parentFolder: "/tmp/a.jpg",
    },
  );
});

test("immichUrl returns null when Immich is disabled or incomplete, and normalized URL when enabled", async () => {
  mockImmichSettings = { enabled: false, url: "https://immich.example.com", hasKey: true };
  assert.equal(await immichUrl(), null);

  mockImmichSettings = { enabled: true, url: "   ", hasKey: true };
  assert.equal(await immichUrl(), null);

  mockImmichSettings = { enabled: true, url: "https://immich.example.com", hasKey: false };
  assert.equal(await immichUrl(), null);

  mockImmichSettings = { enabled: true, url: "  https://immich.example.com/api/  ", hasKey: true };
  assert.equal(await immichUrl(), "https://immich.example.com");
});

test("findTargetEntry matches exact path + version and falls back to path", () => {
  const list = [
    { path: "/a/b.jpg", version: 0, imgid: 1 },
    { path: "/a/b.jpg", version: 2, imgid: 2 },
    { path: "/c/d.jpg", version: 0, imgid: 3 },
  ];

  assert.equal(findTargetEntry(list, "/a/b.jpg", 2)?.imgid, 2);
  assert.equal(findTargetEntry(list, "/a/b.jpg", 0)?.imgid, 1);
  assert.equal(findTargetEntry(list, "/c/d.jpg", 5)?.imgid, 3);
  assert.equal(findTargetEntry(list, "/nonexistent.jpg", 0), undefined);
});

test("App.tsx and FileMenu.tsx wire Show in Library and Immich menu gating", () => {
  const appSrc = readFileSync(new URL("../app/src/App.tsx", import.meta.url), "utf8");
  assert.ok(appSrc.includes("showInLibraryTarget"));
  assert.ok(appSrc.includes("immichMenuState"));
  assert.ok(appSrc.includes("canShowResultsMenu"));
  assert.ok(appSrc.includes("onShowInLibrary="));
  assert.ok(appSrc.includes("revealThumb={thumbRevealKey}"));
  assert.ok(appSrc.includes("revealKey={folderRevealKey}"));

  const fileMenuSrc = readFileSync(new URL("../app/src/FileMenu.tsx", import.meta.url), "utf8");
  assert.ok(fileMenuSrc.includes("library.menu.showInLibrary"));
});
