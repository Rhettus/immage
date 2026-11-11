//! Removes private values from text that leaves the machine (the support bundle).
//!
//! Two stages run in order on every `scrub` call:
//!
//! 1. Known values (home, user, host, folder, photo and extra values the
//!    caller supplies) are matched in every form they take in a log: any case,
//!    percent-encoded, JSON-escaped (`\/`, `\\`, `\uXXXX`), with either path
//!    separator. All variants of all values go into one alternation, longest
//!    first, so `/home/rhett/Pictures/Trip` wins over `rhett`.
//! 2. Patterns catch what nobody told us about: credentials in URLs, private
//!    URL hosts, emails, other people's home paths, photo file names and
//!    serial numbers.
//!
//! Matching rules for known values (by the length of the value in characters):
//! - home values always match, embedded in anything;
//! - under 3 characters: whole tokens only (no letter or digit on either side);
//! - 3 to 5 characters: embedded, unless letters sit on both sides, so a login
//!   `tom` goes from `tom-laptop` and `/Users/tom` but not from `automatic`;
//! - longer: embedded anywhere (`rhetts-macbook-air-2`, `rhett.local`);
//! - photo names always need a non-alphanumeric edge on both sides, so
//!   `DSC01234` goes from `DSC01234_01.ARW` and `DSC01234.ARW.xmp` but not from
//!   `DSC012345`. Only the name is replaced; suffix and extension stay, which
//!   keeps the extension's case and gives every file of one photo one number;
//! - folder components below a known home are known values too, except generic
//!   names (`Pictures`, `Documents`, ...) and date-like names (`2026-11-11`),
//!   which would eat ordinary words and timestamps. Those still go as part of
//!   the full path.
//!
//! Timestamps, version numbers, hex hashes, system paths and ordinary log words
//! are never matched by stage 2 (serials only on lines that name a serial).
#![allow(dead_code)]

use regex::{Captures, Regex, RegexBuilder};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

/// Private values the app knows. Empty strings and 1-character values are ignored.
#[derive(Default, Clone, Debug)]
pub struct Known {
    pub home: Vec<String>,
    pub users: Vec<String>,
    pub hosts: Vec<String>,
    pub folders: Vec<String>,
    pub photos: Vec<String>,
    pub extra: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Kind {
    Home,
    User,
    Host,
    Folder,
    Photo,
    Extra,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Home => "home",
            Kind::User => "user",
            Kind::Host => "host",
            Kind::Folder => "folder",
            Kind::Photo => "photo",
            Kind::Extra => "extra",
        }
    }
}

struct Entry {
    kind: Kind,
    /// lowercase identity: the same canon always gets the same placeholder
    canon: String,
    chars: usize,
}

#[derive(Default)]
struct Numbers {
    folder: HashMap<String, usize>,
    photo: HashMap<String, usize>,
    extra: HashMap<String, usize>,
}

fn number(map: &mut HashMap<String, usize>, key: &str) -> usize {
    let next = map.len() + 1;
    *map.entry(key.to_string()).or_insert(next)
}

pub struct Scrubber {
    re: Option<Regex>,
    lookup: HashMap<String, usize>,
    entries: Vec<Entry>,
    nums: Numbers,
    counts: BTreeMap<String, usize>,
}

const GENERIC_DIRS: &[&str] = &[
    "pictures", "documents", "desktop", "downloads", "photos", "images", "library", "users",
    "home", "media", "volumes", "mnt", "tmp", "var", "music", "movies", "videos", "public",
    "dcim", "raw", "raws", "jpg", "export", "exports", "import", "imports",
];

const PHOTO_EXTS: &str = "arw|cr2|cr3|crw|nef|nrw|orf|raf|rw2|pef|srw|dng|raw|3fr|erf|kdc|mrw|sr2|srf|x3f|iiq|jpeg|jpg|tiff|tif|heic|heif|jxl|xmp";

fn trim_seps(s: &str) -> &str {
    s.trim().trim_end_matches(['/', '\\'])
}

fn norm_path(s: &str) -> String {
    trim_seps(s).replace('\\', "/").to_lowercase()
}

fn is_datelike(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_digit() || "-_. :".contains(c))
}

fn photo_stem(name: &str) -> String {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut stem = file;
    // strip sidecar and photo extensions, so DSC01234.ARW.xmp gives DSC01234
    for _ in 0..2 {
        if let Some((s, ext)) = stem.rsplit_once('.') {
            if !s.is_empty() && PHOTO_EXTS.split('|').any(|e| e.eq_ignore_ascii_case(ext)) {
                stem = s;
            }
        }
    }
    stem.to_string()
}

fn pct_encode(s: &str, keep_slash: bool, plus: bool) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || "-._~".contains(c) || (keep_slash && c == '/') {
            out.push(c);
        } else if plus && c == ' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{:02x}", b));
        }
    }
    out
}

fn esc_unicode(s: &str, prefix: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for u in c.encode_utf16(&mut buf) {
                out.push_str(&format!("{prefix}{:04x}", u));
            }
        }
    }
    out
}

/// Every form `value` takes in logs, preferences and JSON.
fn variants(value: &str) -> Vec<String> {
    let mut bases = vec![value.to_string()];
    if value.contains('\\') {
        bases.push(value.replace('\\', "/"));
    }
    if value.contains('/') {
        bases.push(value.replace('/', "\\"));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut add = |s: String| {
        if !s.is_empty() && seen.insert(s.to_lowercase()) {
            out.push(s);
        }
    };
    for b in &bases {
        for bs in [false, true] {
            for sl in [false, true] {
                for u in 0..3 {
                    if u == 2 && !bs {
                        continue;
                    }
                    let mut s = b.clone();
                    if bs {
                        s = s.replace('\\', "\\\\");
                    }
                    if sl {
                        s = s.replace('/', "\\/");
                    }
                    s = match u {
                        1 => esc_unicode(&s, "\\u"),
                        2 => esc_unicode(&s, "\\\\u"),
                        _ => s,
                    };
                    add(s);
                }
            }
        }
        add(pct_encode(b, true, false));
        add(pct_encode(b, false, false));
        add(pct_encode(b, true, true));
    }
    out
}

impl Scrubber {
    pub fn new(known: Known) -> Self {
        let mut entries: Vec<Entry> = Vec::new();
        let mut raw: Vec<(String, usize)> = Vec::new(); // value, entry index
        let mut seen: HashMap<(Kind, String), usize> = HashMap::new();
        // a second value with the same canon is another spelling of the same entry
        let mut push = |kind: Kind, value: &str, canon: String, entries: &mut Vec<Entry>| {
            let chars = value.chars().count();
            if chars < 2 {
                return;
            }
            if let Some(&i) = seen.get(&(kind, canon.clone())) {
                raw.push((value.to_string(), i));
                return;
            }
            seen.insert((kind, canon.clone()), entries.len());
            entries.push(Entry { kind, canon, chars });
            raw.push((value.to_string(), entries.len() - 1));
        };
        let homes: Vec<String> = known.home.iter().map(|h| norm_path(h)).collect();
        for h in &known.home {
            let v = trim_seps(h);
            push(Kind::Home, v, norm_path(v), &mut entries);
        }
        for (list, kind) in [
            (&known.users, Kind::User),
            (&known.hosts, Kind::Host),
            (&known.extra, Kind::Extra),
        ] {
            for v in list {
                let v = v.trim();
                push(kind, v, v.to_lowercase(), &mut entries);
            }
        }
        for f in &known.folders {
            let v = trim_seps(f);
            let n = norm_path(v);
            let rel = homes
                .iter()
                .filter(|h| !h.is_empty())
                .find_map(|h| n.strip_prefix(&format!("{h}/")).map(str::to_string));
            match &rel {
                Some(r) => {
                    // the same folder under every spelling of home (C:\Users\x vs /Users/x)
                    let canon = format!("~/{r}");
                    push(Kind::Folder, v, canon.clone(), &mut entries);
                    let tail = &v[v.len() - r.len()..];
                    for h in &known.home {
                        push(Kind::Folder, &format!("{}/{tail}", trim_seps(h)), canon.clone(), &mut entries);
                    }
                }
                None => push(Kind::Folder, v, n, &mut entries),
            }
            // below a known home every component is private; elsewhere only the last
            let originals: Vec<&str> = v.split(['/', '\\']).filter(|c| !c.is_empty()).collect();
            let take = match &rel {
                Some(r) => r.split('/').filter(|c| !c.is_empty()).count(),
                None => 1,
            };
            for comp in originals.iter().rev().take(take) {
                let lc = comp.to_lowercase();
                if GENERIC_DIRS.contains(&lc.as_str()) || is_datelike(comp) {
                    continue;
                }
                push(Kind::Folder, comp, lc, &mut entries);
            }
        }
        for p in &known.photos {
            let stem = photo_stem(p.trim());
            push(Kind::Photo, &stem, stem.to_lowercase(), &mut entries);
            // a path also gives its folder
            let t = p.trim();
            if let Some(i) = t.rfind(['/', '\\']) {
                let dir = trim_seps(&t[..i]);
                if dir.chars().count() >= 2 {
                    push(Kind::Folder, dir, norm_path(dir), &mut entries);
                }
            }
        }

        let mut lookup: HashMap<String, usize> = HashMap::new();
        let mut alts: Vec<String> = Vec::new();
        for (value, idx) in &raw {
            for v in variants(value) {
                let key = v.to_lowercase();
                if let std::collections::hash_map::Entry::Vacant(slot) = lookup.entry(key) {
                    slot.insert(*idx);
                    alts.push(v);
                }
            }
        }
        alts.sort_by_key(|v| std::cmp::Reverse(v.len()));
        let re = if alts.is_empty() {
            None
        } else {
            let pat: Vec<String> = alts.iter().map(|a| regex::escape(a)).collect();
            RegexBuilder::new(&pat.join("|"))
                .case_insensitive(true)
                .size_limit(256 << 20)
                .build()
                .ok()
        };
        Scrubber {
            re,
            lookup,
            entries,
            nums: Numbers::default(),
            counts: BTreeMap::new(),
        }
    }

    pub fn scrub(&mut self, text: &str) -> String {
        let s = self.stage1(text);
        stage2(&s, &mut self.nums, &mut self.counts)
    }

    /// Replacements so far, by kind (home, user, host, folder, photo, extra,
    /// email, url, path, serial).
    pub fn counts(&self) -> BTreeMap<String, usize> {
        self.counts.clone()
    }

    fn stage1(&mut self, text: &str) -> String {
        let Some(re) = &self.re else {
            return text.to_string();
        };
        let mut out = String::with_capacity(text.len());
        let (mut copied, mut pos) = (0, 0);
        while pos <= text.len() {
            let Some(m) = re.find_at(text, pos) else { break };
            let ent = self
                .lookup
                .get(&m.as_str().to_lowercase())
                .map(|&i| &self.entries[i]);
            let prev = text[..m.start()].chars().next_back();
            let next = text[m.end()..].chars().next();
            let ok = ent.is_some_and(|e| allowed(e, prev, next));
            let Some(e) = ent.filter(|_| ok) else {
                pos = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
                continue;
            };
            out.push_str(&text[copied..m.start()]);
            let ph = match e.kind {
                Kind::Home => "~".to_string(),
                Kind::User => "<user>".to_string(),
                Kind::Host => "<host>".to_string(),
                Kind::Folder => format!("folder-{}", number(&mut self.nums.folder, &e.canon)),
                Kind::Photo => format!("photo-{}", number(&mut self.nums.photo, &e.canon)),
                Kind::Extra => format!("<extra-{}>", number(&mut self.nums.extra, &e.canon)),
            };
            out.push_str(&ph);
            *self.counts.entry(e.kind.name().to_string()).or_default() += 1;
            copied = m.end();
            pos = m.end();
        }
        out.push_str(&text[copied..]);
        out
    }
}

fn allowed(e: &Entry, prev: Option<char>, next: Option<char>) -> bool {
    let an = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    let al = |c: Option<char>| c.is_some_and(char::is_alphabetic);
    match e.kind {
        Kind::Home => true,
        Kind::Photo => !an(prev) && !an(next),
        _ if e.chars < 3 => !an(prev) && !an(next),
        _ if e.chars <= 5 => !(al(prev) && al(next)),
        _ => true,
    }
}

struct Stage2 {
    url: Regex,
    email: Regex,
    user_path: Regex,
    unc: Regex,
    photo: Regex,
    serial: Regex,
}

fn stage2_res() -> &'static Stage2 {
    static RES: OnceLock<Stage2> = OnceLock::new();
    RES.get_or_init(|| {
        // a path separator in plain, JSON-escaped or doubled form
        let sep = r"(?:\\\\|\\/|\\|/)";
        let comp = r#"[^\s"'<>|,;:*?\\/]"#;
        Stage2 {
            url: Regex::new(
                r#"(?i)\b(?P<scheme>[a-z][a-z0-9+.\-]*)://(?P<ui>[^\s/@"'?#]*@)?(?P<host>\[[0-9a-f:]+\]|[^\s/:?#"'@]+)(?::(?P<port>\d+))?(?P<rest>[/?#][^\s"']*)?"#,
            )
            .unwrap(),
            email: Regex::new(
                r"(?P<local>(?:<user>|[A-Za-z0-9._%+\-])+)@(?P<dom>[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+)",
            )
            .unwrap(),
            user_path: Regex::new(&format!(
                r"(?i)(?P<pre>^|[^\w.\-~])(?P<root>(?:[A-Za-z]:)?{sep}(?:home|users)|{sep}run{sep}media|{sep}media|{sep}mnt|{sep}volumes)(?P<sep>{sep})(?P<name>{comp}+)(?P<tail>(?:{sep}{comp}*)*)"
            ))
            .unwrap(),
            unc: Regex::new(
                r#"(?P<pre>^|[\s"'=(\[,])\\\\(?P<host>[^\s\\/"'?.<][^\s\\/"']*)(?P<tail>(?:\\[^\s\\/"']+)*)"#,
            )
            .unwrap(),
            photo: Regex::new(&format!(
                r"(?i)(?P<stem>[\w+\-]+(?:\.[\w+\-]+)*?)(?P<ext>\.(?:{PHOTO_EXTS})(?:\.xmp)?)\b"
            ))
            .unwrap(),
            serial: Regex::new(
                r#"(?i)(?P<key>\b(?:(?:body|lens|camera)[ _-]?)?(?:serial(?:[ _-]?(?:number|num|no\.?))?|s/n)\b|\bsn\b)(?P<mid>["']?\s*[:=#]?\s*["']?)(?P<val>[A-Za-z0-9][A-Za-z0-9._\-]{3,})"#,
            )
            .unwrap(),
        }
    })
}

fn bump(counts: &mut BTreeMap<String, usize>, kind: &str) {
    *counts.entry(kind.to_string()).or_default() += 1;
}

fn private_host(host: &str) -> bool {
    let h = host.to_lowercase();
    if h.contains('<') || h == "localhost" {
        return h.contains('<');
    }
    if !h.contains('.') && !h.contains(':') {
        return true; // single-label names are LAN machines
    }
    for suffix in [".local", ".lan", ".internal", ".home", ".localdomain", ".home.arpa"] {
        if h.ends_with(suffix) {
            return true;
        }
    }
    let p: Vec<u8> = h.split('.').filter_map(|x| x.parse().ok()).collect();
    h.split('.').count() == 4
        && p.len() == 4
        && (p[0] == 10
            || (p[0] == 192 && p[1] == 168)
            || (p[0] == 172 && (16..32).contains(&p[1]))
            || (p[0] == 169 && p[1] == 254))
}

fn stage2(text: &str, nums: &mut Numbers, counts: &mut BTreeMap<String, usize>) -> String {
    let r = stage2_res();

    let s = r.url.replace_all(text, |c: &Captures| {
        let whole = c.get(0).unwrap().as_str();
        if c["scheme"].eq_ignore_ascii_case("file") {
            return whole.to_string();
        }
        if c.name("ui").is_none() && !private_host(&c["host"]) {
            return whole.to_string();
        }
        let trimmed = whole.trim_end_matches(['.', ',', ';', ')', ']']);
        bump(counts, "url");
        format!("<url>{}", &whole[trimmed.len()..])
    });

    let s = r.email.replace_all(&s, |_: &Captures| {
        bump(counts, "email");
        "<email>".to_string()
    });

    let s = r.user_path.replace_all(&s, |c: &Captures| {
        let whole = c.get(0).unwrap().as_str().to_string();
        let root = &c["root"];
        let name = c["name"].to_lowercase();
        let rl = root.to_lowercase();
        let is_home = rl.ends_with("home") || rl.ends_with("users");
        let sep = &c["sep"];
        let out = if is_home {
            if ["public", "default", "shared", "all users"].contains(&name.as_str()) {
                return whole;
            }
            let tail = if c["tail"].is_empty() {
                String::new()
            } else {
                format!("{sep}<path>")
            };
            format!("{root}{sep}<user>{tail}")
        } else {
            if name == "macintosh" {
                return whole;
            }
            format!("{root}{sep}<path>")
        };
        bump(counts, "path");
        format!("{}{out}", &c["pre"])
    });

    let s = r.unc.replace_all(&s, |c: &Captures| {
        bump(counts, "path");
        let tail = if c["tail"].is_empty() { "" } else { "\\<path>" };
        format!("{}\\\\<host>{tail}", &c["pre"])
    });

    let s = r.photo.replace_all(&s, |c: &Captures| {
        let stem = &c["stem"];
        let lc = stem.to_lowercase();
        // already a placeholder from stage 1 (photo-3, photo-3_01)
        if lc.strip_prefix("photo-").is_some_and(|r| r.starts_with(|d: char| d.is_ascii_digit())) {
            return c.get(0).unwrap().as_str().to_string();
        }
        bump(counts, "photo");
        format!("photo-{}{}", number(&mut nums.photo, &lc), &c["ext"])
    });

    let s = r.serial.replace_all(&s, |c: &Captures| {
        let val = &c["val"];
        if !val.chars().any(|d| d.is_ascii_digit()) {
            return c.get(0).unwrap().as_str().to_string();
        }
        bump(counts, "serial");
        format!("{}{}<serial>", &c["key"], &c["mid"])
    });

    s.into_owned()
}

fn usable(s: &str) -> bool {
    let t = s.trim();
    t.chars().count() >= 2
        && !["root", "user", "admin", "guest", "localhost", "home", "default"]
            .contains(&t.to_lowercase().as_str())
}

fn push_unique(list: &mut Vec<String>, v: &str) {
    let v = v.trim();
    if usable(v) && !list.iter().any(|x| x.eq_ignore_ascii_case(v)) {
        list.push(v.to_string());
    }
}

/// Home, login, full name (Unix passwd, when readable) and host of this machine.
pub fn known_from_system() -> Known {
    let mut k = Known::default();
    let env = |n: &str| std::env::var(n).ok().filter(|v| !v.trim().is_empty());
    for n in ["HOME", "USERPROFILE"] {
        if let Some(h) = env(n) {
            push_unique(&mut k.home, trim_seps(&h));
            if let Some(last) = trim_seps(&h).rsplit(['/', '\\']).next() {
                push_unique(&mut k.users, last);
            }
        }
    }
    if let (Some(d), Some(p)) = (env("HOMEDRIVE"), env("HOMEPATH")) {
        push_unique(&mut k.home, trim_seps(&format!("{d}{p}")));
    }
    for n in ["USER", "USERNAME", "LOGNAME"] {
        if let Some(u) = env(n) {
            push_unique(&mut k.users, &u);
        }
    }
    #[cfg(unix)]
    if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
        let logins = k.users.clone();
        for line in passwd.lines() {
            let f: Vec<&str> = line.split(':').collect();
            if f.len() > 4 && logins.iter().any(|l| l.eq_ignore_ascii_case(f[0])) {
                if let Some(full) = f[4].split(',').next() {
                    push_unique(&mut k.users, full);
                }
            }
        }
    }
    let mut hosts: Vec<String> = Vec::new();
    if let Some(h) = sysinfo::System::host_name() {
        hosts.push(h);
    }
    for n in ["HOSTNAME", "COMPUTERNAME"] {
        hosts.extend(env(n));
    }
    for h in hosts {
        push_unique(&mut k.hosts, &h);
        if let Some(first) = h.split('.').next() {
            push_unique(&mut k.hosts, first);
        }
    }
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> Known {
        Known {
            home: vec![
                "/Users/rhett".into(),
                "C:\\Users\\Rhett".into(),
                "/home/rhett".into(),
            ],
            users: vec!["rhett".into(), "Rhett Smith".into()],
            hosts: vec!["Rhetts-MacBook-Air-2.local".into(), "Rhetts-MacBook-Air-2".into()],
            folders: vec!["/Users/rhett/Pictures/Iceland Trip 2026".into()],
            photos: vec!["DSC01234.ARW".into()],
            extra: vec!["immich.example.net".into()],
        }
    }

    const SURVIVORS: &[&str] = &[
        "2026-11-11T12:46:56.123Z",
        "/usr/lib/libfoo.so",
        "C:\\Windows\\System32",
        "darktable 5.7.0",
        "0a4e683",
        "https://example.com/docs",
        "/opt/immage/bin/immage",
        "/System/Library/Frameworks",
        "C:\\Program Files\\Immage",
        "thread 7 started, cache 512 MB",
    ];

    fn planted() -> String {
        let mut s = String::new();
        for l in [
            "2026-11-11T12:46:56.123Z INFO darktable 5.7.0 build 0a4e683 starting",
            "2026-11-11T12:46:57.000Z INFO loading /usr/lib/libfoo.so and /opt/immage/bin/immage",
            "INFO /System/Library/Frameworks C:\\Windows\\System32 C:\\Program Files\\Immage",
            "INFO thread 7 started, cache 512 MB; docs https://example.com/docs",
            "INFO opening /Users/rhett/Pictures/Iceland Trip 2026/DSC01234.ARW",
            "INFO sidecar C:\\Users\\Rhett\\Pictures\\Iceland Trip 2026\\DSC01234.ARW.xmp",
            "INFO json {\"path\":\"\\/Users\\/rhett\\/Pictures\\/Iceland Trip 2026\\/DSC01234_01.ARW\",\"win\":\"C:\\\\Users\\\\Rhett\\\\Pictures\\\\Iceland Trip 2026\\\\dsc01234.arw\"}",
            "INFO uri file:///Users/rhett/Pictures/Iceland%20Trip%202026/DSC01234.ARW and %2FUsers%2Frhett%2Fx",
            "INFO connected to Rhetts-MacBook-Air-2.local, RHETTS-MACBOOK-AIR-2, rhett.local",
            "INFO user=RHETT login rhett cache /home/rhett/.cache/immage/thumbs",
            "INFO imported \"Iceland Trip 2026\" (folder name alone), iceland%20trip%202026",
            "INFO selected DSC01234 and DSC01234_01.ARW and dsc01234-2.jpg",
            "INFO other user /home/alice/Pictures/Trip/IMG_0042.CR3 and /Volumes/Backup/Photos",
            "INFO share \\\\nas\\photos\\2026\\IMG_1.jpg and C:\\Users\\bob\\Desktop\\x.tif",
            "INFO mail rhett@example.org and alice@corp.example.com",
            "INFO api https://user:pw@immich.example.net/api/assets and http://192.168.1.20:2283/x",
            "INFO immich host immich.example.net, name Rhett Smith, Rhett%20Smith",
            "INFO body serial: 3012345, lens serial number 0000AB12CD, S/N: A1B2C3D4",
            "INFO {\"SerialNumber\": \"XYZ98765\"}",
        ] {
            s.push_str(l);
            s.push('\n');
        }
        s
    }

    fn pct_decode(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn json_unescape(s: &str) -> String {
        let c: Vec<char> = s.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < c.len() {
            if c[i] == '\\' && i + 1 < c.len() {
                if c[i + 1] == 'u' && i + 5 < c.len() {
                    let h: String = c[i + 2..(i + 6).min(c.len())].iter().collect();
                    if let Some(ch) = u32::from_str_radix(&h, 16).ok().and_then(char::from_u32) {
                        out.push(ch);
                        i += 6;
                        continue;
                    }
                }
                out.push(c[i + 1]);
                i += 2;
                continue;
            }
            out.push(c[i]);
            i += 1;
        }
        out
    }

    /// Every normalization an auditor might apply before searching.
    fn forms(s: &str) -> Vec<String> {
        let mut v = vec![s.to_string()];
        v.push(pct_decode(s));
        v.push(json_unescape(s));
        v.push(pct_decode(&json_unescape(s)));
        v.push(json_unescape(&pct_decode(s)));
        let mut all = Vec::new();
        for f in v {
            all.push(f.to_lowercase());
            all.push(f.to_lowercase().replace('\\', "/"));
            all.push(f.to_lowercase().replace("\\/", "/"));
        }
        all
    }

    fn assert_clean(out: &str, private: &[&str]) {
        for f in forms(out) {
            for p in private {
                assert!(
                    !f.contains(&p.to_lowercase()),
                    "private value {p:?} survived in:\n{out}"
                );
            }
        }
    }

    #[test]
    fn planted_log_is_clean_and_survivors_intact() {
        let mut s = Scrubber::new(known());
        let out = s.scrub(&planted());
        assert_clean(
            &out,
            &[
                "rhett",
                "rhetts-macbook-air-2",
                "iceland trip 2026",
                "iceland",
                "dsc01234",
                "users/rhett",
                "alice",
                "bob",
                "img_0042",
                "img_1",
                "pw@",
                "user:pw",
                "immich.example.net",
                "example.org",
                "corp.example.com",
                "192.168.1.20",
                "smith",
                "3012345",
                "0000ab12cd",
                "a1b2c3d4",
                "xyz98765",
                "backup",
                "nas",
            ],
        );
        for keep in SURVIVORS {
            assert!(out.contains(keep), "{keep:?} must survive in:\n{out}");
        }
        // untouched lines are byte-identical
        for l in planted().lines().take(4) {
            assert!(out.contains(l), "line changed: {l}");
        }
    }

    #[test]
    fn placeholder_forms() {
        let mut s = Scrubber::new(known());
        let out = s.scrub(&planted());
        for want in [
            "photo-1.ARW",
            "photo-1_01.ARW",
            "photo-1.ARW.xmp",
            "photo-1-2.jpg",
            "folder-1",
            "<host>",
            "<user>",
            "<email>",
            "<url>",
            "<serial>",
            "/home/<user>/<path>",
            "/Volumes/<path>",
            "C:\\Users\\<user>\\<path>",
            "\\\\<host>\\<path>",
            "~/.cache/immage/thumbs",
        ] {
            assert!(out.contains(want), "{want:?} missing in:\n{out}");
        }
        // bare name, no extension
        assert!(out.contains("selected photo-1 and"), "{out}");
        // extension case is kept
        assert!(out.contains("photo-1.arw"), "{out}");
    }

    #[test]
    fn placeholders_are_stable_across_calls() {
        let mut s = Scrubber::new(known());
        let a = s.scrub("a /Users/rhett/Pictures/Iceland Trip 2026/DSC01234.ARW b IMG_9.CR3 c IMG_8.CR3");
        let b = s.scrub("x IMG_8.CR3 y DSC01234_02.ARW z IMG_9.CR3 w Iceland Trip 2026");
        assert!(a.contains("folder-1/photo-1.ARW"), "{a}");
        assert!(a.contains("photo-2.CR3") && a.contains("photo-3.CR3"), "{a}");
        assert!(b.contains("x photo-3.CR3 y photo-1_02.ARW z photo-2.CR3"), "{b}");
        // the folder name alone is its own value but stable too
        let c = s.scrub("Iceland Trip 2026 and iceland trip 2026");
        let d = s.scrub("ICELAND TRIP 2026");
        assert_eq!(c.split(" and ").next(), c.split(" and ").nth(1));
        assert_eq!(c.split(" and ").next().unwrap(), d);
    }

    #[test]
    fn counts_by_kind() {
        let mut s = Scrubber::new(known());
        s.scrub("rhett@example.org rhett /home/rhett/x DSC01234.ARW https://a:b@h.example.com/ serial: 12345678");
        let c = s.counts();
        assert_eq!(c.get("email"), Some(&1), "{c:?}");
        // the email's local part is a known user, counted there and as an email
        assert_eq!(c.get("user"), Some(&2), "{c:?}");
        assert_eq!(c.get("home"), Some(&1), "{c:?}");
        assert_eq!(c.get("photo"), Some(&1), "{c:?}");
        assert_eq!(c.get("url"), Some(&1), "{c:?}");
        assert_eq!(c.get("serial"), Some(&1), "{c:?}");
    }

    #[test]
    fn short_values_whole_tokens_only() {
        let mut s = Scrubber::new(Known {
            users: vec!["al".into(), "tom".into(), "x".into()],
            ..Known::default()
        });
        let out = s.scrub("alpha al, (al) al's tom-laptop automatic tomato x xylophone");
        assert_eq!(
            out,
            "alpha <user>, (<user>) <user>'s <user>-laptop automatic <user>ato x xylophone"
        );
    }

    #[test]
    fn embedded_matches_for_longer_values() {
        let mut s = Scrubber::new(Known {
            users: vec!["rhett".into()],
            hosts: vec!["rhetts-macbook-air-2".into()],
            ..Known::default()
        });
        let out = s.scrub("rhetts-macbook-air-2.local rhett.local /srv/rhett-data x_rhett_x");
        assert_eq!(out, "<host>.local <user>.local /srv/<user>-data x_<user>_x");
    }

    #[test]
    fn non_ascii_forms() {
        let mut s = Scrubber::new(Known {
            users: vec!["René Ünal".into()],
            home: vec!["/Users/René".into()],
            ..Known::default()
        });
        let log = "René Ünal, Ren\\u00e9 \\u00dcnal, Ren%C3%A9%20%C3%9Cnal, RENÉ ÜNAL, /Users/Ren%C3%A9/x, \"\\/Users\\/Ren\\u00e9\\/y\"";
        let out = s.scrub(log);
        assert_clean(&out, &["ren", "ünal", "nal"]);
        assert!(out.contains("~/x"), "{out}");
        assert_eq!(out.matches("<user>").count(), 4, "{out}");
    }

    #[test]
    fn longest_value_wins() {
        let mut s = Scrubber::new(Known {
            users: vec!["rhett".into()],
            folders: vec!["/home/rhett/Pictures/Trip".into()],
            home: vec!["/home/rhett".into()],
            ..Known::default()
        });
        let out = s.scrub("/home/rhett/Pictures/Trip/a.txt /home/rhett/other");
        assert_eq!(out, "folder-1/a.txt ~/other");
    }

    #[test]
    fn folder_components_below_home() {
        let mut s = Scrubber::new(Known {
            home: vec!["/Users/rhett".into()],
            folders: vec!["/Users/rhett/Pictures/2026/Iceland Trip".into()],
            ..Known::default()
        });
        let out = s.scrub(
            "Iceland Trip; Pictures stay; 2026-11-11T10:00:00Z; year 2026; /Users/rhett/Pictures/2026/Iceland Trip/x",
        );
        assert_eq!(
            out,
            "folder-1; Pictures stay; 2026-11-11T10:00:00Z; year 2026; folder-2/x"
        );
    }

    #[test]
    fn unknown_user_areas_and_system_paths() {
        let mut s = Scrubber::new(Known::default());
        let out = s.scrub(
            "/home/zoe/Pictures/a.txt /Users/zoe C:\\Users\\Zoe\\AppData C:\\\\Users\\\\Zoe\\\\x /run/media/zoe/Disk/x /media/zoe/d /usr/share /Users/Shared/x C:\\Users\\Public\\p /Library/Caches /home",
        );
        assert_eq!(
            out,
            "/home/<user>/<path> /Users/<user> C:\\Users\\<user>\\<path> C:\\\\Users\\\\<user>\\\\<path> /run/media/<path> /media/<path> /usr/share /Users/Shared/x C:\\Users\\Public\\p /Library/Caches /home"
        );
    }

    #[test]
    fn mnt_mounts_are_private() {
        let mut s = Scrubber::new(Known::default());
        assert_eq!(s.scrub("/mnt/nas/Photos/a.txt /mnt"), "/mnt/<path> /mnt");
    }

    #[test]
    fn urls_emails_serials() {
        let mut s = Scrubber::new(Known::default());
        let out = s.scrub(
            "see https://example.com/x. and (https://me:pw@host.example.com/a?b=1), http://nas.local:8080/p http://nas/x http://localhost:3000/ mail me+tag@mail.example.com.\nserial: 1234567 Serial Number=AB12-CD34 serial: unknown S/N 77AA77 \"lens_serial\": \"L0012345\" snapshot: abcdef1 serial port 9600",
        );
        assert_eq!(
            out,
            "see https://example.com/x. and (<url>), <url> <url> http://localhost:3000/ mail <email>.\nserial: <serial> Serial Number=<serial> serial: unknown S/N <serial> \"lens_serial\": \"<serial>\" snapshot: abcdef1 serial port 9600"
        );
    }

    #[test]
    fn photo_names_without_known_list() {
        let mut s = Scrubber::new(Known::default());
        let out = s.scrub("IMG_0001.CR3 img_0001.xmp IMG_0001.CR3.xmp libfoo.so v5.7.0 notes.txt a.b.jpeg.");
        assert_eq!(
            out,
            "photo-1.CR3 photo-1.xmp photo-1.CR3.xmp libfoo.so v5.7.0 notes.txt photo-2.jpeg."
        );
        // already scrubbed text is left alone
        let again = s.scrub(&out);
        assert_eq!(again, out);
    }

    #[test]
    fn empty_known_is_a_noop_for_clean_text() {
        let mut s = Scrubber::new(Known::default());
        for keep in SURVIVORS {
            assert_eq!(&s.scrub(keep), keep);
        }
        assert!(s.counts().is_empty());
    }

    #[test]
    fn known_from_system_is_usable() {
        let k = known_from_system();
        for v in k.home.iter().chain(&k.users).chain(&k.hosts) {
            assert!(v.chars().count() >= 2, "{v:?}");
        }
        // building a scrubber from it must not panic or eat plain log text
        let mut s = Scrubber::new(k);
        let out = s.scrub("2026-11-11T12:46:56.123Z darktable 5.7.0 0a4e683");
        assert!(out.starts_with("2026-11-11T12:46:56.123Z"), "{out}");
    }
}
