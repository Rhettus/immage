// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use serde_json::{json, Number, Value};
use std::path::Path;
use crate::typed_edit::{AgxPresetsReply, AgxProfile, CombineMember, FilmFetch, FilmStocks, LensMenu, LookReply, MapView, MaskInfo, MasksReply, NewSpot, Spot, SpotSource, SpotsReply, UprightReply};
use crate::typed_export::LookInfo;
use tauri::{ipc::Response, AppHandle, State};
use crate::AppState;
use crate::bindings;
use crate::frame_output;
use crate::export_cmds::path_inside;
use crate::export_cmds::pick_save;
use crate::export_cmds::pick_files;

// replace a mask's shapes (made when missing)
#[tauri::command]
#[specta::specta]
pub(crate) async fn mask_shapes(state: State<'_, AppState>, name: String, shapes: Vec<Value>) -> Result<(), String> {
    state.engine("mask_shapes")
        .request(json!({ "cmd": "mask", "name": name, "shapes": shapes })).map(|_| ())
}

// replace a combined mask's members ([{ mask, opacity 0-1, invert }]) and
// the range components its instances take, which drives masks' shared
// instances (app/src/localMerge.ts)
#[tauri::command]
#[specta::specta]
pub(crate) async fn combine(state: State<'_, AppState>, name: String, members: Vec<CombineMember>, ranges: Option<Vec<Value>>)
    -> Result<(), String> {
    state.engine("combine")
        .request(json!({ "cmd": "combine", "name": name, "members": members, "ranges": ranges })).map(|_| ())
}

// the open image's masks, with these fields ({ op: [field] }) of their
// instances
#[tauri::command]
#[specta::specta]
pub(crate) async fn masks(state: State<'_, AppState>, fields: std::collections::BTreeMap<String, Vec<String>>) -> Result<Vec<MaskInfo>, String> {
    let reply = state.engine("masks").request(json!({ "cmd": "masks", "fields": fields }))?;
    serde_json::from_value::<MasksReply>(reply).map(|r| r.masks).map_err(|e| format!("masks: unexpected reply: {e}"))
}

// the Lensfun lenses Lens Corrections can use for the open photo, and the
// one matched from its EXIF (the engine's _lens_menu)
#[tauri::command]
#[specta::specta]
pub(crate) async fn lenses(state: State<'_, AppState>) -> Result<LensMenu, String> {
    let reply = state.engine("lenses").request(json!({ "cmd": "lenses" }))?;
    serde_json::from_value(reply).map_err(|e| format!("lenses: unexpected reply: {e}"))
}

// Upright's fit of rotate and perspective: { rotation, lensshift_v,
// lensshift_h, fit }. Guided passes its drawn lines (x1, y1, x2, y2 in the
// input image, 0-1)
#[tauri::command]
#[specta::specta]
pub(crate) async fn upright(state: State<'_, AppState>, mode: String, guides: Option<Vec<Number>>, aspect: Number)
    -> Result<UprightReply, String> {
    let mut req = json!({ "cmd": "upright", "mode": mode, "aspect": aspect });
    if let Some(g) = guides {
        req["guides"] = json!(g);
    }
    let reply = state.engine("upright").request(req)?;
    serde_json::from_value(reply).map_err(|e| format!("upright: unexpected reply: {e}"))
}

// how much range components select over a width x height grid of the shown
// image: u32 width and height, then one byte per point
#[tauri::command]
#[specta::specta]
pub(crate) async fn range_map(state: State<'_, AppState>, ranges: Vec<Value>, width: u32, height: u32) -> Result<bindings::Frame, String> {
    let mut engine = state.engine("range_map");
    engine.request(json!({ "cmd": "range_map", "ranges": ranges, "width": width, "height": height,
                           "out": state.range_path }))?;
    // read while the engine is still ours, so no other request overwrites it
    let map = frame_output::FrameOutput::read(&state.range_path).map_err(|e| format!("range map: {e}"))?;
    drop(engine);
    let mut out = Vec::with_capacity(8 + map.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&map);
    Ok(bindings::Frame(Response::new(out)))
}

// the zone (Zone System, scene-referred) of each point of a width x height
// grid of the shown image, as (z + 1) * 20, and the zones' statistics:
// u32 width, height and JSON length, the JSON, then one byte per point
#[tauri::command]
#[specta::specta]
pub(crate) async fn zones(state: State<'_, AppState>, width: u32, height: u32, transition: Number, stage: String)
    -> Result<bindings::Frame, String> {
    let mut engine = state.engine("zones");
    let reply = engine.request(json!({ "cmd": "zones", "width": width, "height": height, "transition": transition,
                                       "stage": stage, "out": state.range_path }))?;
    let map = frame_output::FrameOutput::read(&state.range_path).map_err(|e| format!("zones: {e}"))?;
    drop(engine);
    let stats = reply.to_string().into_bytes();
    let mut out = Vec::with_capacity(12 + stats.len() + map.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&(stats.len() as u32).to_le_bytes());
    out.extend_from_slice(&stats);
    out.extend_from_slice(&map);
    Ok(bindings::Frame(Response::new(out)))
}

// a mask as darktable makes it, refinements and all, over a width x height
// grid of the shown image: laid out as range_map's reply. `op` instead of a
// name maps that module's own mask (a details threshold's). with a view
// ({ x, y, scale }, as a render's), the grid is that window of the image at
// that scale, width x height pixels or what of it lies on the image
#[tauri::command]
#[specta::specta]
pub(crate) async fn mask_map(state: State<'_, AppState>, name: Option<String>, op: Option<String>, width: u32, height: u32,
                  view: Option<MapView>) -> Result<bindings::Frame, String> {
    let mut engine = state.engine("mask_map");
    let mut req = json!({ "cmd": "mask_map", "width": width, "height": height, "out": state.range_path });
    if let Some(n) = name {
        req["name"] = json!(n);
    }
    if let Some(o) = op {
        req["op"] = json!(o);
    }
    if let Some(v) = view {
        req["x"] = json!(v.x);
        req["y"] = json!(v.y);
        req["scale"] = json!(v.scale);
    }
    let reply = engine.request(req)?;
    let width = reply["width"].as_u64().map_or(width, |w| w as u32);
    let height = reply["height"].as_u64().map_or(height, |h| h as u32);
    let map = frame_output::FrameOutput::read(&state.range_path).map_err(|e| format!("mask map: {e}"))?;
    drop(engine);
    let mut out = Vec::with_capacity(8 + map.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&map);
    Ok(bindings::Frame(Response::new(out)))
}

// the spektrafilm data pack and its films and papers (engine main.c,
// _spektra_stocks)
#[tauri::command]
#[specta::specta]
pub(crate) async fn spektra_stocks(state: State<'_, AppState>) -> Result<FilmStocks, String> {
    let reply = state.engine("spektra_stocks").request(json!({ "cmd": "spektra_stocks" }))?;
    serde_json::from_value(reply).map_err(|e| format!("spektra_stocks: unexpected reply: {e}"))
}

// the pack's download: `action` "start", "cancel" or "status"; none waits
// for the network (engine main.c, _spektra_fetch)
#[tauri::command]
#[specta::specta]
pub(crate) async fn spektra_fetch(state: State<'_, AppState>, action: String) -> Result<FilmFetch, String> {
    let reply = state.engine("spektra_fetch").request(json!({ "cmd": "spektra_fetch", "action": action }))?;
    serde_json::from_value(reply).map_err(|e| format!("spektra_fetch: unexpected reply: {e}"))
}

// the image's heal and clone spots: replaced by `spots` when given, and
// replied as the engine keeps them
#[tauri::command]
#[specta::specta]
pub(crate) async fn spots(state: State<'_, AppState>, spots: Option<Vec<Spot>>) -> Result<Vec<Spot>, String> {
    let mut req = json!({ "cmd": "spots" });
    if let Some(s) = spots {
        req["spots"] = json!(s);
    }
    let reply = state.engine("spots").request(req)?;
    serde_json::from_value::<SpotsReply>(reply).map(|r| r.spots).map_err(|e| format!("spots: unexpected reply: {e}"))
}

// the spots off for the Before view, and back on
#[tauri::command]
#[specta::specta]
pub(crate) async fn spots_enable(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.engine("spots_enable").request(json!({ "cmd": "spots_enable", "on": on })).map(|_| ())
}

// where a new spot should copy from: { sx, sy }
#[tauri::command]
#[specta::specta]
pub(crate) async fn spot_source(state: State<'_, AppState>, spot: NewSpot) -> Result<SpotSource, String> {
    let reply = state.engine("spot_source").request(json!({ "cmd": "spot_source", "spot": spot }))?;
    serde_json::from_value(reply).map_err(|e| format!("spot_source: unexpected reply: {e}"))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn mask_delete(state: State<'_, AppState>, name: String) -> Result<(), String> {
    state.engine("mask_delete").request(json!({ "cmd": "mask_delete", "name": name })).map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn mask_rename(state: State<'_, AppState>, name: String, to: String) -> Result<(), String> {
    state.engine("mask_rename").request(json!({ "cmd": "mask_rename", "name": name, "to": to })).map(|_| ())
}

// the darktable styles shipped as looks: "<pack> - <group>_<name>.dtstyle",
// then the user's own, by the name the engine shows them under
fn list_looks(state: &AppState) -> Result<Vec<LookInfo>, String> {
    let mut looks = Vec::new();
    let packs = std::fs::read_dir(&state.looks_dir).map_err(|e| format!("looks: {e}"))?;
    for pack in packs.flatten() {
        let Ok(files) = std::fs::read_dir(pack.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("dtstyle") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            let title = stem.split_once(" - ").map_or(stem, |(_, t)| t);
            let (group, name) = title.split_once('_').unwrap_or(("Looks", title));
            looks.push(LookInfo { name: name.into(), group: group.into(), path: path.to_string_lossy().into_owned(), user: None });
        }
    }
    looks.sort_by_key(|l| (l.group.clone(), l.name.clone()));
    let Ok(files) = std::fs::read_dir(&state.user_looks_dir) else { return Ok(looks) };
    for file in files.flatten() {
        let path = file.path();
        if path.extension().and_then(|e| e.to_str()) != Some("dtstyle") {
            continue;
        }
        let Some(name) = std::fs::read_to_string(&path).ok().as_deref().and_then(style_name) else { continue };
        looks.push(LookInfo { name: style_label(&name).into(), group: "My Looks".into(),
                              path: path.to_string_lossy().into_owned(), user: Some(true) });
    }
    Ok(looks)
}

// a .dtstyle's style name as the engine reads it (_style_items() in
// engine/main.c): the first <name>, with &amp; its only entity
fn style_name(text: &str) -> Option<String> {
    let a = text.find("<name>")? + "<name>".len();
    let z = a + text[a..].find("</name>")?;
    Some(text[a..z].replace("&amp;", "&"))
}

// the name's last "|" segment, which is how the engine shows it
fn style_label(name: &str) -> &str {
    name.rsplit_once('|').map_or(name, |(_, l)| l)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn looks_list(state: State<'_, AppState>) -> Result<Vec<LookInfo>, String> {
    list_looks(&state)
}

// a darktable style file added to the user's looks, renamed "<name> (2)"
// where a look has its name already, as a photo knows its look by name;
// returns the name it took
pub(crate) fn import_look(state: &AppState, path: &Path) -> Result<String, String> {
    let shown = path.display();
    let size = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?.len();
    if size > 4 << 20 {
        return Err("this file is too large to be a look".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{shown}: {e}"))?;
    let name = style_name(&text)
        .filter(|_| text.contains("<darktable_style"))
        .ok_or("this file is not a darktable style")?;
    let taken: std::collections::HashSet<String> = list_looks(state)?
        .iter().map(|l| l.name.clone()).collect();
    let label = style_label(&name).trim();
    let label = if label.is_empty() { "Imported look" } else { label };
    let mut fresh = label.to_string();
    for n in 2.. {
        if !taken.contains(&fresh) { break }
        fresh = format!("{label} ({n})");
    }
    let renamed = match name.rsplit_once('|') {
        Some((group, _)) => format!("{group}|{fresh}"),
        None => fresh.clone(),
    };
    let text = if renamed == name { text } else {
        let a = text.find("<name>").unwrap() + "<name>".len();
        let z = a + text[a..].find("</name>").unwrap();
        format!("{}{}{}", &text[..a], renamed.replace('&', "&amp;"), &text[z..])
    };

    std::fs::create_dir_all(&state.user_looks_dir).map_err(|e| format!("looks: {e}"))?;
    let stem = fresh.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let mut dest = state.user_looks_dir.join(format!("{stem}.dtstyle"));
    for n in 2.. {
        if !dest.exists() { break }
        dest = state.user_looks_dir.join(format!("{stem} ({n}).dtstyle"));
    }
    state.engine("look_import").request(json!({ "cmd": "style_forget", "name": renamed }))?;
    std::fs::write(&dest, text).map_err(|e| format!("looks: {e}"))?;
    Ok(fresh)
}

// a look's style file, copied where the save dialog asks; false when it is
// cancelled. `from` must be one of the looks
#[tauri::command]
#[specta::specta]
pub(crate) async fn look_export(app: AppHandle, state: State<'_, AppState>, from: String, name: String) -> Result<bool, String> {
    let from = path_inside(Path::new(&from), &[&state.looks_dir, &state.user_looks_dir])?;
    let Some(to) = pick_save(&app, "darktable style", &["dtstyle"], &format!("{name}.dtstyle")).await? else {
        return Ok(false);
    };
    std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", to.display()))?;
    Ok(true)
}

// one of the user's own looks; the shipped ones stay
#[tauri::command]
#[specta::specta]
pub(crate) async fn look_delete(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = path_inside(Path::new(&path), &[&state.user_looks_dir])
        .map_err(|_| "only an imported look can be deleted".to_string())?;
    std::fs::remove_file(&path).map_err(|e| format!("looks: {e}"))
}

// apply a look to the open image, or with no path take it off; returns the
// look in use
#[tauri::command]
#[specta::specta]
pub(crate) async fn look_apply(state: State<'_, AppState>, path: Option<String>) -> Result<Option<String>, String> {
    let path = match path {
        Some(p) => Some(path_inside(Path::new(&p), &[&state.looks_dir, &state.user_looks_dir])?),
        None => None,
    };
    let reply = state.engine("look_apply").request(json!({ "cmd": "look", "path": path }))?;
    serde_json::from_value::<LookReply>(reply).map(|r| r.look).map_err(|e| format!("look: unexpected reply: {e}"))
}

// how strongly the look applies, 0-100
#[tauri::command]
#[specta::specta]
pub(crate) async fn look_amount(state: State<'_, AppState>, amount: Number) -> Result<(), String> {
    state.engine("look_amount").request(json!({ "cmd": "look_amount", "amount": amount })).map(|_| ())
}

// the AgX presets in darktable's own `data.db` in the config folder,
// converted by the engine to the current version: { presets: [{ name, params }] }
#[tauri::command]
#[specta::specta]
pub(crate) async fn agx_presets(state: State<'_, AppState>, fields: Vec<String>) -> Result<AgxPresetsReply, String> {
    let reply = state.engine("agx_presets").request(json!({ "cmd": "agx_presets", "fields": fields }))?;
    serde_json::from_value(reply).map_err(|e| format!("agx_presets: unexpected reply: {e}"))
}

// the same from a `.dtpreset` or `.dtstyle` the user picks in the dialog
// opened here; null when it is cancelled
#[tauri::command]
#[specta::specta]
pub(crate) async fn agx_presets_pick(app: AppHandle, state: State<'_, AppState>, fields: Vec<String>)
    -> Result<Option<AgxPresetsReply>, String> {
    let picked = pick_files(&app, "darktable preset or style", &["dtpreset", "dtstyle"], false).await?;
    let Some(file) = picked.first() else { return Ok(None) };
    let reply = state.engine("agx_presets").request(json!({ "cmd": "agx_presets", "file": file, "fields": fields }))?;
    serde_json::from_value(reply).map(Some).map_err(|e| format!("agx_presets: unexpected reply: {e}"))
}

// the AgX presets the user loaded into the Profile menu, a document the
// front end shapes; none yet is an empty list
#[tauri::command]
#[specta::specta]
pub(crate) async fn agx_profiles_load(state: State<'_, AppState>) -> Result<Vec<AgxProfile>, String> {
    let path = state.presets_path.with_file_name("agx-profiles.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("AgX presets: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("AgX presets: {e}")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn agx_profiles_save(state: State<'_, AppState>, profiles: Vec<AgxProfile>) -> Result<(), String> {
    let path = state.presets_path.with_file_name("agx-profiles.json");
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("AgX presets: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("AgX presets: {e}"))
}

