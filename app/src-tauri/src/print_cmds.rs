// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use crate::typed_edit::{FontFamily, FontsReply};
use crate::typed_export::{PrintProfile, PrintProfilesReply, PrintReply, PrinterInfoReply, PrintersReply};
use tauri::{AppHandle, State};
use crate::AppState;
use crate::export_cmds::pick_files;
use crate::export_cmds::pick_save;
use crate::export_cmds::merge;

// the installed font families and their faces, as the engine draws them
#[tauri::command]
#[specta::specta]
pub(crate) async fn fonts(state: State<'_, AppState>) -> Result<Vec<FontFamily>, String> {
    let reply = state.engine("fonts").request(json!({ "cmd": "fonts" }))?;
    serde_json::from_value::<FontsReply>(reply).map(|r| r.families).map_err(|e| format!("fonts: unexpected reply: {e}"))
}

// the Print panel (engine/print.c): printer profiles, soft proofing,
// printers and the print itself
fn without_ok(mut reply: Value) -> Value {
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
    }
    reply
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn print_profiles(state: State<'_, AppState>) -> Result<Vec<PrintProfile>, String> {
    let reply = state.engine("print_profiles").request(json!({ "cmd": "print_profiles" }))?;
    serde_json::from_value::<PrintProfilesReply>(reply).map(|r| r.profiles)
        .map_err(|e| format!("print_profiles: unexpected reply: {e}"))
}

// a printer profile the user picks in the dialog opened here, copied among
// the engine's own; null when it is cancelled
#[tauri::command]
#[specta::specta]
pub(crate) async fn print_profile_add(app: AppHandle, state: State<'_, AppState>) -> Result<Option<PrintProfile>, String> {
    let picked = pick_files(&app, "ICC profile", &["icc", "icm", "ICC", "ICM"], false).await?;
    let Some(path) = picked.first() else { return Ok(None) };
    let reply = state.engine("print_profile_add").request(json!({ "cmd": "print_profile_add", "path": path }))?;
    serde_json::from_value(reply).map(Some).map_err(|e| format!("print_profile_add: unexpected reply: {e}"))
}

// `mode` "off", "proof" or "gamut"; replies whether the view changed, and
// the front end renders again if so
#[tauri::command]
#[specta::specta]
pub(crate) async fn softproof(state: State<'_, AppState>, mode: String, profile: Option<String>, intent: Option<i64>)
    -> Result<bool, String> {
    let reply = state.engine("softproof").request(json!({
        "cmd": "softproof", "mode": mode, "profile": profile.unwrap_or_default(), "intent": intent.unwrap_or(0),
    }))?;
    Ok(reply["changed"].as_bool().unwrap_or(false))
}

// { available, printers: [{ name, description, default }] }
#[tauri::command]
#[specta::specta]
pub(crate) async fn printers(state: State<'_, AppState>) -> Result<PrintersReply, String> {
    let reply = state.engine("printers").request(json!({ "cmd": "printers" }))?;
    serde_json::from_value(reply).map_err(|e| format!("printers: unexpected reply: {e}"))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn printer_info(state: State<'_, AppState>, name: String) -> Result<PrinterInfoReply, String> {
    let reply = state.engine("printer_info").request(json!({ "cmd": "printer", "name": name }))?;
    serde_json::from_value(reply).map_err(|e| format!("printer: unexpected reply: {e}"))
}

// `request` without any `pdf` the page sent: the engine writes a PDF to that
// path, so only the one Rust gets from its own save dialog may reach it
fn without_pdf(mut request: Value) -> Value {
    if let Some(o) = request.as_object_mut() {
        o.remove("pdf");
    }
    request
}

// the save dialog for a print's PDF, named `pdf_name` as the page suggests;
// None when there is no PDF to write, Some(None) when the user cancelled
async fn pick_pdf(app: &AppHandle, pdf_name: Option<&str>) -> Result<Option<Option<PathBuf>>, String> {
    match pdf_name {
        Some(name) => Ok(Some(pick_save(app, "PDF", &["pdf"], name).await?)),
        None => Ok(None),
    }
}

// the reply with the path of the PDF written, for the page to show
fn with_pdf(mut reply: Value, pdf: Option<&Path>) -> Value {
    if let (Some(p), Some(o)) = (pdf, reply.as_object_mut()) {
        o.insert("pdf".into(), json!(p.to_string_lossy()));
    }
    reply
}

// the engine's print reply with the PDF's path, as the page gets it
fn print_reply(result: Result<Value, String>, pdf: Option<&Path>) -> Result<Option<PrintReply>, String> {
    let reply = with_pdf(without_ok(result?), pdf);
    serde_json::from_value(reply).map(Some).map_err(|e| format!("print: unexpected reply: {e}"))
}

// renders the photo as its edit is now and prints it, or, given `pdf_name`,
// writes a PDF where the user picks (null when they cancel), on the export
// thread as an export does (export_images), so editing goes on
#[tauri::command]
#[specta::specta]
pub(crate) async fn print_photo(app: AppHandle, state: State<'_, AppState>, imgid: i64, request: Map<String, Value>,
                     pdf_name: Option<String>) -> Result<Option<PrintReply>, String> {
    let mut req = without_pdf(Value::Object(request));
    let pdf = match pick_pdf(&app, pdf_name.as_deref()).await? {
        Some(None) => return Ok(None),
        Some(Some(p)) => {
            req["pdf"] = json!(p.to_string_lossy());
            Some(p)
        }
        None => None,
    };
    let tagged = state.tagged.clone();
    let held = tagged.tag();
    state.engine("print_photo").request(json!({ "cmd": "export_hold", "job": held, "imgids": [imgid] }))?;
    req["cmd"] = json!("print");
    req["job"] = json!(held);
    req["imgid"] = json!(imgid);
    let t = tagged.clone();
    let tag = t.tag();
    let result = tauri::async_runtime::spawn_blocking(move || t.request(tag, req))
        .await.map_err(|e| e.to_string()).and_then(|r| r);
    let t = tagged.clone();
    let tag = t.tag();
    let _ = tauri::async_runtime::spawn_blocking(move || t.request(tag, json!({ "cmd": "export_release", "job": held })))
        .await;
    print_reply(result, pdf.as_deref())
}

// a sheet of photos, each as its edit is now (print_photo's way): the Cells
// layout's pages of boxes and labels are in `request`, `imgids` the photos
// they hold, which the engine takes a snapshot of as each page reaches it.
// `pdf_name` is print_photo's: the PDF goes where the user picks, null when
// they cancel
#[tauri::command]
#[specta::specta]
pub(crate) async fn print_sheet(app: AppHandle, state: State<'_, AppState>, job: u64, imgids: Vec<i64>, request: Map<String, Value>,
                     pdf_name: Option<String>) -> Result<Option<PrintReply>, String> {
    let mut req = without_pdf(Value::Object(request));
    let pdf = match pick_pdf(&app, pdf_name.as_deref()).await? {
        Some(None) => return Ok(None),
        Some(Some(p)) => {
            req["pdf"] = json!(p.to_string_lossy());
            Some(p)
        }
        None => None,
    };
    let tagged = state.tagged.clone();
    state.engine("print_sheet").request(json!({ "cmd": "export_hold", "job": job, "imgids": imgids }))?;
    req["cmd"] = json!("print");
    let t = tagged.clone();
    // each photo placed reaches the page as a merge's progress, and Stop as a merge's
    let result = tauri::async_runtime::spawn_blocking(move || merge(app, t, job, req))
        .await.map_err(|e| e.to_string()).and_then(|r| r);
    let t = tagged.clone();
    let tag = t.tag();
    let _ = tauri::async_runtime::spawn_blocking(move || t.request(tag, json!({ "cmd": "export_release", "job": job })))
        .await;
    print_reply(result, pdf.as_deref())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_print_request_loses_the_pages_pdf_path() {
        let req = without_pdf(json!({ "pdf": "/home/u/.bashrc", "dpi": 300 }));
        assert_eq!(req, json!({ "dpi": 300 }));
        let reply = with_pdf(json!({}), Some(Path::new("/tmp/a.pdf")));
        assert_eq!(reply["pdf"], "/tmp/a.pdf");
        assert_eq!(with_pdf(json!({}), None), json!({}));
    }
}
