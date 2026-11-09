#[test]
fn rounded_fractional_viewport_dimension_deserializes_as_render_u32() {
    // `render` takes width and height as u32 command arguments. Confirm the
    // exact rounded IPC number is accepted by the same serde scalar type.
    let width: u32 = serde_json::from_value(serde_json::json!(1169)).unwrap();
    let height: u32 = serde_json::from_value(serde_json::json!(801)).unwrap();
    assert_eq!((width, height), (1169, 801));
    assert!(serde_json::from_value::<u32>(serde_json::json!(1168.52)).is_err());
}
