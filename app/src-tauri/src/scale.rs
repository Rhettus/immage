// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Linux on Wayland: the real scale of the screen the window is on. GTK 3,
// which WebKitGTK and Tauri are built on, knows only whole scales, so at
// 125% it draws the window at 2× and the compositor shrinks it: the page's
// devicePixelRatio says 2. The compositor itself says 1.25, as the output's
// mode (its pixels) over its xdg-output logical size, read here on a
// Wayland connection of our own. GNOME and KDE both send both

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{delegate_noop, Connection, Dispatch, QueueHandle};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};

#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct Output {
    // the current mode, in the screen's pixels, before any rotation
    pub mode: (i32, i32),
    // where the output is and how large, in the compositor's logical pixels
    pub position: (i32, i32),
    pub size: (i32, i32),
}

impl Output {
    // larger side over larger side, so a screen turned 90° compares alike
    fn scale(&self) -> Option<f64> {
        let px = self.mode.0.max(self.mode.1);
        let logical = self.size.0.max(self.size.1);
        (px > 0 && logical > 0).then(|| px as f64 / logical as f64)
    }
}

// the scale of the output at this logical position, or of the only one
pub fn pick(outputs: &[Output], at: (i32, i32)) -> Option<f64> {
    let o = outputs.iter().find(|o| o.position == at)
        .or(if outputs.len() == 1 { outputs.first() } else { None })?;
    o.scale()
}

#[derive(Default)]
struct State {
    outputs: Vec<Output>,
}

// the scale of the output whose logical top-left corner is `at`; none off
// Wayland, or when the compositor has no xdg-output
pub fn output_scale(at: (i32, i32)) -> Option<f64> {
    let conn = Connection::connect_to_env().ok()?;
    let (globals, mut queue) = registry_queue_init::<State>(&conn).ok()?;
    let qh = queue.handle();
    let manager: zxdg_output_manager_v1::ZxdgOutputManagerV1 = globals.bind(&qh, 1..=3, ()).ok()?;
    let mut state = State::default();
    let named = globals.contents().with_list(|list| {
        list.iter().filter(|g| g.interface == "wl_output").map(|g| (g.name, g.version)).collect::<Vec<_>>()
    });
    for (i, (name, version)) in named.into_iter().enumerate() {
        let output: wl_output::WlOutput = globals.registry().bind(name, version.min(4), &qh, i);
        manager.get_xdg_output(&output, &qh, i);
        state.outputs.push(Output::default());
    }
    // the first round trip binds, the second brings the outputs' events
    queue.roundtrip(&mut state).ok()?;
    queue.roundtrip(&mut state).ok()?;
    pick(&state.outputs, at)
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents,
             _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<wl_output::WlOutput, usize> for State {
    fn event(state: &mut Self, _: &wl_output::WlOutput, event: wl_output::Event, i: &usize,
             _: &Connection, _: &QueueHandle<Self>) {
        if let wl_output::Event::Mode { flags, width, height, .. } = event {
            let current = matches!(flags, wayland_client::WEnum::Value(f) if f.contains(wl_output::Mode::Current));
            if current { state.outputs[*i].mode = (width, height); }
        }
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, usize> for State {
    fn event(state: &mut Self, _: &zxdg_output_v1::ZxdgOutputV1, event: zxdg_output_v1::Event, i: &usize,
             _: &Connection, _: &QueueHandle<Self>) {
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => state.outputs[*i].position = (x, y),
            zxdg_output_v1::Event::LogicalSize { width, height } => state.outputs[*i].size = (width, height),
            _ => {}
        }
    }
}

delegate_noop!(State: ignore zxdg_output_manager_v1::ZxdgOutputManagerV1);

#[cfg(test)]
mod tests {
    use super::*;

    const GNOME_125: Output = Output { mode: (2560, 1440), position: (0, 0), size: (2048, 1152) };

    #[test]
    fn fractional_scale_from_mode_and_logical_size() {
        assert_eq!(pick(&[GNOME_125], (0, 0)), Some(1.25));
        // a lone output is the window's, wherever GTK puts it
        assert_eq!(pick(&[GNOME_125], (99, 99)), Some(1.25));
    }

    #[test]
    fn the_window_s_output_of_several() {
        let side = Output { mode: (3840, 2160), position: (2048, 0), size: (2560, 1440) };
        assert_eq!(pick(&[GNOME_125, side], (2048, 0)), Some(1.5));
        assert_eq!(pick(&[GNOME_125, side], (5, 5)), None);
    }

    #[test]
    fn a_turned_screen() {
        let turned = Output { mode: (2560, 1440), position: (0, 0), size: (1152, 2048) };
        assert_eq!(pick(&[turned], (0, 0)), Some(1.25));
    }

    #[test]
    fn an_output_without_its_events() {
        assert_eq!(pick(&[Output::default()], (0, 0)), None);
    }
}
