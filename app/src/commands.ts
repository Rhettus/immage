// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the one way the page calls the Rust layer's typed commands. bindings.ts is
// generated from the Rust signatures (src-tauri/src/bindings.rs; regenerate it
// with `IMMAGE_WRITE_BINDINGS=1 cargo test bindings` in app/src-tauri, which
// plain `cargo test` also checks), so a renamed argument or a changed reply
// fails the type check here. calls reject with the command's error string, as
// `invoke` does. the page calls no command by name: verify/typed-commands.test.mjs
// fails when a file other than bindings.ts imports `invoke`.
//
// binary replies (mapTile, later frames) come back as an ArrayBuffer
export { commands } from "./bindings";
export type * from "./bindings";
