// The touchpad pinch's scale-to-wheel conversion, apart from pinch.rs so it
// builds and is tested on every platform (pinch.rs needs GTK, Linux only)

// App.tsx scales by exp(-deltaY * 0.006) for a wheel event with ctrl
pub const CTRL_WHEEL_RATE: f64 = 0.006;

// what one pinch update does: the scale to remember, and the wheel deltaY to
// send, none when it would be zero or not a number
#[derive(Debug, PartialEq)]
pub struct Update {
    pub last: f64,
    pub delta: Option<f64>,
}

// `scale` runs from 1 at the pinch's start and `last` is the previous
// update's; none (nothing remembered, nothing sent) unless both are positive
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn update(scale: f64, last: f64) -> Option<Update> {
    if !(scale > 0.0 && last > 0.0) {
        return None;
    }
    let delta = -(scale / last).ln() / CTRL_WHEEL_RATE;
    Some(Update { last: scale, delta: (delta.is_finite() && delta != 0.0).then_some(delta) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_change_sends_nothing_but_remembers() {
        assert_eq!(update(1.0, 1.0), Some(Update { last: 1.0, delta: None }));
        assert_eq!(update(1.7, 1.7), Some(Update { last: 1.7, delta: None }));
    }

    #[test]
    fn spreading_zooms_in_with_a_negative_delta_and_pinching_in_zooms_out() {
        let spread = update(1.5, 1.0).unwrap().delta.unwrap();
        let pinch = update(0.5, 1.0).unwrap().delta.unwrap();
        assert!(spread < 0.0 && pinch > 0.0);
        // App.tsx's exp(-deltaY * rate) gives the scale back
        assert!(((-spread * CTRL_WHEEL_RATE).exp() - 1.5).abs() < 1e-12);
        assert!(((-pinch * CTRL_WHEEL_RATE).exp() - 0.5).abs() < 1e-12);
    }

    #[test]
    fn each_update_zooms_by_its_change_since_the_last() {
        let a = update(2.0, 1.0).unwrap();
        let b = update(3.0, a.last).unwrap();
        let whole = update(3.0, 1.0).unwrap().delta.unwrap();
        assert!((a.delta.unwrap() + b.delta.unwrap() - whole).abs() < 1e-9);
    }

    #[test]
    fn zero_negative_and_nan_scales_are_ignored() {
        for (s, l) in [(0.0, 1.0), (-1.0, 1.0), (1.0, 0.0), (1.0, -2.0), (f64::NAN, 1.0), (1.0, f64::NAN)] {
            assert_eq!(update(s, l), None, "{s} {l}");
        }
    }

    #[test]
    fn an_infinite_scale_is_remembered_but_sends_nothing() {
        assert_eq!(update(f64::INFINITY, 1.0), Some(Update { last: f64::INFINITY, delta: None }));
    }
}
