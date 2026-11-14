// Linux: a touchpad pinch zooms the photo, as it does on the Mac, instead of
// the whole page. WebKitGTK gives a pinch to its own GtkGestureZoom, which
// scales the page and never tells the page (WebKitWebViewBase.cpp,
// webkitWebViewBaseZoomChanged). GTK 3 runs that bubble-phase gesture only
// when the widget's "event" signal leaves the event unhandled
// (gtkwidget.c, gtk_widget_event_internal), so taking it there keeps it from
// WebKit. it reaches the page as what WKWebView and WebView2 send for a
// pinch: a wheel event with ctrl, which the viewer's wheel handler zooms
// with (App.tsx)

use gtk::glib::Propagation;
use gtk::prelude::*;
use std::cell::Cell;
use std::rc::Rc;

// App.tsx scales by exp(-deltaY * 0.006) for a wheel event with ctrl
const CTRL_WHEEL_RATE: f64 = 0.006;

// GdkTouchpadGesturePhase
const PHASE_BEGIN: i8 = 0;
const PHASE_UPDATE: i8 = 1;

pub fn install(window: &tauri::WebviewWindow) {
    let page = window.clone();
    let installed = window.with_webview(move |pw| {
        // the pinch's scale runs from 1 at its start; each update zooms by
        // its change since the last one
        let last = Rc::new(Cell::new(1.0f64));
        pw.inner().connect_event(move |_, event| {
            let Some(pinch) = event.downcast_ref::<gtk::gdk::EventTouchpadPinch>() else {
                return Propagation::Proceed;
            };
            let phase = pinch.as_ref().phase;
            let scale = pinch.scale();
            if phase == PHASE_BEGIN {
                last.set(1.0);
            } else if phase == PHASE_UPDATE && scale > 0.0 && last.get() > 0.0 {
                let ratio = scale / last.get();
                last.set(scale);
                // the position is in the webview's own coordinates, which
                // are CSS pixels at the page's zoom of 1
                let (x, y) = pinch.position();
                let delta = -ratio.ln() / CTRL_WHEEL_RATE;
                if delta.is_finite() && delta != 0.0 {
                    let _ = page.eval(format!(
                        "(()=>{{const t=document.elementFromPoint({x},{y});t&&t.dispatchEvent(new WheelEvent('wheel',\
                         {{bubbles:true,cancelable:true,ctrlKey:true,deltaY:{delta},clientX:{x},clientY:{y}}}))}})()"
                    ));
                }
            }
            Propagation::Stop
        });
    });
    if let Err(e) = installed {
        eprintln!("pinch: cannot take the touchpad pinch from the webview: {e}");
    }
}
