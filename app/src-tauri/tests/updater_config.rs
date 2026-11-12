// The in-app update is enforced inside tauri-plugin-updater: it verifies the
// minisign signature of every download against the public key in
// tauri.conf.json, and offers only a version newer than the running one. Those
// refusals cannot be driven without a running app, so these tests pin what
// Immage controls: the key is a well-formed minisign key, the feed is https,
// and nothing weakens the plugin's defaults (invalid certs, plain http,
// downgrades, a custom version comparator).
use std::path::Path;

use serde_json::Value;

fn read(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(name)).unwrap()
}

fn updater() -> Value {
    let conf: Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    conf["plugins"]["updater"].clone()
}

// standard base64, padded
fn base64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("not base64: {}", c as char),
    };
    let s = s.trim().trim_end_matches('=').as_bytes();
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
    for &c in s {
        acc = acc << 6 | val(c) as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

#[test]
fn updater_pubkey_is_a_minisign_public_key() {
    let conf = updater();
    // Tauri's pubkey is the base64 of the .pub file: a comment line, then the key
    let file = String::from_utf8(base64(conf["pubkey"].as_str().expect("a pubkey"))).unwrap();
    let mut lines = file.lines();
    let comment = lines.next().unwrap();
    assert!(comment.starts_with("untrusted comment: minisign public key"), "{comment}");
    let key = base64(lines.next().expect("a key line"));
    // "Ed" algorithm, 8 byte key id, 32 byte ed25519 key
    assert_eq!(key.len(), 42);
    assert_eq!(&key[..2], b"Ed");
    assert!(key[10..].iter().any(|&b| b != 0), "an all-zero key");
}

#[test]
fn updater_feed_is_https_and_nothing_weakens_verification() {
    let conf = updater();
    let endpoints = conf["endpoints"].as_array().expect("endpoints");
    assert!(!endpoints.is_empty());
    for e in endpoints {
        let e = e.as_str().unwrap();
        assert!(e.starts_with("https://"), "{e}");
        assert!(e.ends_with("/latest.json"), "{e}");
    }
    for key in ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts",
                "dangerousAcceptInvalidHostnames", "allowDowngrades",
                "dangerous-insecure-transport-protocol", "dangerous-accept-invalid-certs",
                "dangerous-accept-invalid-hostnames", "allow-downgrades"] {
        assert!(conf.get(key).is_none_or(|v| v == &Value::Bool(false)), "{key} is set");
    }
    // the plugin's default: only a version newer than the running one is
    // offered. a comparator set in code would replace that rule
    let main = read("src/main.rs");
    assert!(!main.contains("version_comparator") && !main.contains("default_version_comparator"));
    assert!(!main.contains("dangerous_"));
}

#[test]
fn releases_ship_signed_update_artifacts() {
    let release: Value = serde_json::from_str(&read("tauri.release.conf.json")).unwrap();
    assert_eq!(release["bundle"]["createUpdaterArtifacts"], Value::Bool(true));
}
