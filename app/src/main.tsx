// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// settings come from the Rust layer asynchronously, and many modules read them
// as they load or first render, so the app is imported only once they are in
import { ready } from "./settings";

await ready;
await import("./boot");
