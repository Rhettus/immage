// Lightroom's Export dialog, reduced to what the engine does: presets on
// the left, Lightroom's sections in the middle, a preview of the result on
// the right. settings are remembered
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ImageEntry } from "./library";
import { loadAccel, loadFocusMode } from "./Preferences";
import { Chevron, Collapse } from "./Collapse";
import { Aperture, Archive, BookOpen, Briefcase, Camera, CloudUpload, FileDown, Frame, Globe, Heart, Image, Mail,
         MessageCircle, Monitor, Mountain, Palette, Proportions, Plus, Printer, Save, Share, Smartphone, Star, Tag, Trash, Users,
         type LucideIcon } from "lucide-react";
import { ColorPick, FrameEditor } from "./ExportFrame";
import { KeywordChips, KeywordInput, parseKeyword } from "./Keywording";
import { expand, TOKENS, EMPTY_META, type Meta } from "./exportTokens";
import {
  BUILTINS, DEFAULTS, PERSONAL_KEYS, frameFor, readShared, sharedFile, loadPresets, loadSettings, newId, presetEdited, presetOf, savePresets, saveSettings,
  type ExportPreset, type Settings,
} from "./exportSettings";

export const FILE_MANAGER = navigator.userAgent.includes("Windows") ? "Explorer"
  : navigator.userAgent.includes("Mac") ? "Finder" : "File Manager";

type Album = { id: string; name: string; count: number };

// Lightroom's Super Resolution, as darktable's upscale model on a GPU
// provider; on the CPU the model needs more memory than a computer has
// (main.c), so it is offered only where Preferences finds a GPU
const UPSCALE_MODEL = "upscale-realplksr";

const DATE_FORMATS = ["YYYYMMDD", "YYYY-MM-DD", "YYYY_MM_DD", "YYMMDD", "DD-MM-YYYY", "MM-DD-YYYY"];

// the preview is the export made smaller, at most this long
const PREVIEW_EDGE = 1400;

// what to do with a file that is already there, as Lightroom asks it
type Choice = "unique" | "overwrite" | "skip" | "cancel";
type Ask = { name: string; dir: string; inBatch: boolean; left: number; all: boolean };

type Result = { written: string[]; skipped: string[]; failed: { file: string; error: string }[]; dir?: string;
                uploaded?: number; duplicates?: number };

// which sections are open, remembered
type SectionId = "destination" | "name" | "format" | "frame" | "keywords" | "privacy";
const OPEN_DEFAULT: Record<SectionId, boolean> = {
  destination: true, name: false, format: true, frame: true, keywords: false, privacy: false,
};

// a file name's photo info, as the menu names it
const FILE_TOKEN_NAMES: Record<string, string> = {
  filename: "Original name", title: "Title", caption: "Caption", creator: "Creator", copyright: "Copyright",
  datecaptured: "Date taken", timecaptured: "Time taken", year: "Year", month: "Month", day: "Day",
  camera: "Camera", lens: "Lens", iso: "ISO", rating: "Rating", seq: "Number in this export",
};
const loadOpen = (): Record<SectionId, boolean> => {
  try { return { ...OPEN_DEFAULT, ...JSON.parse(localStorage.getItem("immage.export.open") ?? "{}") }; }
  catch { return OPEN_DEFAULT; }
};

// a Lightroom section: its title, and when shut, what it is set to
function Section({ title, summary, open, onToggle, children }: {
  title: string; summary?: string; open: boolean; onToggle: (alt: boolean) => void; children: React.ReactNode;
}) {
  return (
    <section className={`export-section${open ? " open" : ""}`}>
      <button className="export-section-head" onClick={(e) => onToggle(e.altKey)}>
        <Chevron open={open} />
        <span className="title">{title}</span>
        {!open && summary && <span className="summary-text">{summary}</span>}
      </button>
      <Collapse open={open}><div className="export-section-body">{children}</div></Collapse>
    </section>
  );
}

const ext = (format: Settings["format"]) => format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : format;

const GROUPS_KEY = "immage.exportPresetGroups";

// the icons a preset can be given, by the name it keeps
const PRESET_ICONS: Record<string, LucideIcon> = {
  image: Image, globe: Globe, frame: Frame, cloud: CloudUpload, camera: Camera, aperture: Aperture,
  printer: Printer, mail: Mail, chat: MessageCircle, phone: Smartphone, monitor: Monitor, star: Star,
  heart: Heart, people: Users, work: Briefcase, landscape: Mountain, archive: Archive, book: BookOpen,
  palette: Palette, tag: Tag, ratio: Proportions,
};

// a preset's icon: the one chosen for it, else one from what it does: to
// Immich, on a fixed canvas, framed, resized, or as is
function presetIcon(p: ExportPreset): LucideIcon {
  if (p.icon && PRESET_ICONS[p.icon]) return PRESET_ICONS[p.icon];
  const st = p.settings;
  if (st.target === "immich") return CloudUpload;
  if (st.canvas) return Proportions;
  if (st.borders?.length || st.texts?.length) return Frame;
  if (st.resize) return Globe;
  return Image;
}

export function ExportDialog({ current, selected, shown, canUpscale, onClose, onKeywordsChanged }: {
  current: ImageEntry | null;
  selected: ImageEntry[];                 // the filmstrip's selection, in its order
  shown: ImageEntry[]; canUpscale: boolean; onClose: () => void;
  onKeywordsChanged?: () => void;         // the export added keywords to the originals
}) {
  // with several photos selected the dialog starts on them, as Lightroom's
  const [s, setS] = useState<Settings>(() => {
    const l = loadSettings();
    return selected.length > 1 ? { ...l, scope: "selected" } : l.scope === "selected" ? { ...l, scope: "current" } : l;
  });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the question about one existing file, answered by its buttons
  const [ask, setAsk] = useState<Ask | null>(null);
  const answer = useRef<((c: Choice, all: boolean) => void) | null>(null);
  const askAbout = (q: Omit<Ask, "all">) => new Promise<[Choice, boolean]>((resolve) => {
    setAsk({ ...q, all: false });
    answer.current = (c, all) => { answer.current = null; setAsk(null); resolve([c, all]); };
  });
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setS((old) => { const n = { ...old, [k]: v }; saveSettings(n); return n; });

  const [openSections, setOpenSections] = useState(() => {
    const o = loadOpen();
    if (!loadFocusMode()) return o;
    // one section at a time: the first that was open
    const first = (Object.keys(o) as SectionId[]).find((k) => o[k]);
    return Object.fromEntries(Object.keys(o).map((k) => [k, k === first])) as Record<SectionId, boolean>;
  });
  // focus mode and ⌥ as for the editing panels (App.tsx): opening one
  // section closes the others
  const focusMode = useState(loadFocusMode)[0];
  const toggle = (id: SectionId, alt = false) => setOpenSections((o) => {
    const solo = focusMode ? !alt && !o[id] : alt;
    const n = solo
      ? Object.fromEntries(Object.keys(o).map((k) => [k, k === id && !o[id]])) as Record<SectionId, boolean>
      : { ...o, [id]: !o[id] };
    try { localStorage.setItem("immage.export.open", JSON.stringify(n)); } catch { /* not kept */ }
    return n;
  });

  // ---------------------------------------------------------- presets
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetId, setPresetId] = useState<string | null>(() => localStorage.getItem("immage.export.preset"));
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  // the preset whose icon is being chosen; a click elsewhere closes it
  const [iconFor, setIconFor] = useState<string | null>(null);
  useEffect(() => {
    if (!iconFor) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".icon-picker, .icon-pick")) setIconFor(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setIconFor(null); } };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc, true); };
  }, [iconFor]);
  const setIcon = (id: string, icon: string | null) => {
    storePresets(presets.map((p) => p.id !== id ? p : icon ? { ...p, icon } : (({ icon: _, ...rest }) => rest)(p)));
    setIconFor(null);
  };
  // the preset groups folded shut, kept between uses
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]")); } catch { return new Set(); }
  });
  const toggleGroup = (id: string) => setClosedGroups((old) => {
    const next = new Set(old);
    if (!next.delete(id)) next.add(id);
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify([...next])); } catch { /* not kept */ }
    return next;
  });
  useEffect(() => { void loadPresets().then(setPresets); }, []);
  const choosePreset = (id: string | null) => {
    setPresetId(id);
    try { id ? localStorage.setItem("immage.export.preset", id) : localStorage.removeItem("immage.export.preset"); }
    catch { /* not kept */ }
  };
  const storePresets = (list: ExportPreset[]) => { setPresets(list); void savePresets(list).catch((e) => setError(String(e))); };
  const applyPreset = (p: ExportPreset) => {
    // a user preset holds every setting there was when it was saved; one
    // added since takes its default rather than what the dialog has now
    setS((old) => {
      const base = p.builtin ? {} : presetOf(DEFAULTS);
      for (const k of PERSONAL_KEYS) delete base[k];
      const n = { ...old, ...base, ...structuredClone(p.settings) };
      saveSettings(n);
      return n;
    });
    choosePreset(p.id);
  };
  const chosen = [...BUILTINS, ...presets].find((p) => p.id === presetId) ?? null;
  // sharing: the chosen preset to a file, or a file's presets into My Presets
  const exportPreset = async () => {
    if (!chosen) return;
    const path = await save({ defaultPath: `${chosen.name.replace(/[/\\:*?"<>|]+/g, "_")}.json`,
                              filters: [{ name: "Immage export preset", extensions: ["json"] }] });
    if (path) await invoke("preset_file_write", { path, contents: sharedFile(chosen) }).catch((e) => setError(String(e)));
  };
  const importPresets = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Immage export preset", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const added = readShared(await invoke("preset_file_read", { path }),
                               [...BUILTINS, ...presets].map((p) => p.name));
      if (!added.length) throw new Error("this file has no presets in it");
      storePresets([...presets, ...added]);
      applyPreset(added[0]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const edited = chosen ? presetEdited(chosen, s) : false;
  const finishNaming = () => {
    const name = naming?.name.trim();
    if (naming && name) {
      if (naming.id) storePresets(presets.map((p) => p.id === naming.id ? { ...p, name } : p));
      else {
        const p: ExportPreset = { id: newId(), name, settings: presetOf(s) };
        storePresets([...presets, p]);
        choosePreset(p.id);
      }
    }
    setNaming(null);
  };

  const items = s.scope === "shown" ? shown
    : s.scope === "selected" && selected.length > 1 ? selected
    : current ? [current] : [];
  const upscale = canUpscale ? s.upscale : 0;
  // what a long export is doing: downloading the model, or upscaling
  const [note, setNote] = useState<string | null>(null);
  const busy = progress !== null && result === null;
  const toImmich = s.target === "immich";
  // a canvas is fitted by its longer side: the framed photo has its shape
  const canvas = s.canvas && !upscale;
  const longEdge = canvas ? Math.max(s.canvasW, s.canvasH) : s.resize && !upscale ? s.longEdge : null;

  // Immich: its albums, and the permissions the key lacks for an export,
  // read when Immich is chosen
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [immichError, setImmichError] = useState<string | null>(null);
  const [newAlbum, setNewAlbum] = useState<string | null>(null);
  useEffect(() => {
    if (!toImmich) return;
    setImmichError(null);
    invoke<Album[]>("immich_albums").then(setAlbums).catch((e) => setImmichError(String(e)));
    invoke<string[]>("immich_export_check").then(setMissing).catch(() => setMissing([]));
  }, [toImmich]);
  const createAlbum = async () => {
    const name = newAlbum?.trim();
    if (!name) return;
    try {
      const a = await invoke<Album>("immich_create_album", { name });
      setAlbums((old) => [...(old ?? []), a].sort((x, y) => x.name.localeCompare(y.name)));
      set("album", a.id);
      setNewAlbum(null);
    } catch (e) {
      setImmichError(String(e));
    }
  };

  // every keyword ever used, for the Keywords section's suggestions
  const [knownKeywords, setKnownKeywords] = useState<string[]>([]);
  useEffect(() => { invoke<string[]>("keywords").then(setKnownKeywords).catch(() => {}); }, []);
  const addKeywords = (names: string[]) => {
    const fresh = names.map(parseKeyword).filter((k) => k && !s.keywords.includes(k));
    if (fresh.length) set("keywords", [...s.keywords, ...new Set(fresh)]);
  };

  useEffect(() => {
    const off = listen<{ done: number; total: number }>("export-progress", (e) => setProgress(e.payload));
    return () => { void off.then((f) => f()); };
  }, []);

  // Escape closes, unless an export is running; over the question about an
  // existing file it cancels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (answer.current) answer.current("cancel", false);
      else if (naming) setNaming(null);
      else if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, naming, onClose]);

  // ---------------------------------------------------------- preview
  // the first photo the export covers, exported small with the same frame
  const shownImage = items[0] ?? current;
  const [previewMeta, setPreviewMeta] = useState<{ imgid: number; meta: Meta } | null>(null);
  useEffect(() => {
    if (!shownImage) return;
    const imgid = shownImage.imgid;
    invoke<{ image: { metadata: Meta } }>("meta", { imgid })
      .then((r) => setPreviewMeta({ imgid, meta: r.image.metadata }))
      .catch(() => setPreviewMeta({ imgid, meta: EMPTY_META }));
  }, [shownImage?.imgid]);
  const previewFrame = shownImage && previewMeta?.imgid === shownImage.imgid
    ? frameFor(s, shownImage, previewMeta.meta) : undefined;
  const previewKey = shownImage && previewFrame !== undefined
    ? JSON.stringify({ imgid: shownImage.imgid, frame: previewFrame, longEdge }) : null;
  const [preview, setPreview] = useState<{ url: string; key: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!previewKey || busy || !shownImage) return;
    const seq = ++previewSeq.current;
    const t = window.setTimeout(async () => {
      try {
        const bytes = await invoke<ArrayBuffer>("export_preview", {
          item: { imgid: shownImage.imgid, stem: "preview", frame: previewFrame },
          options: { dir: "", format: "jpeg", colorSpace: "srgb", conflict: "overwrite", longEdge },
          cap: PREVIEW_EDGE,
        });
        if (seq !== previewSeq.current) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        setPreview((old) => { if (old) URL.revokeObjectURL(old.url); return { url, key: previewKey }; });
        setPreviewError(null);
      } catch (e) {
        if (seq === previewSeq.current) setPreviewError(String(e));
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [previewKey, busy]);
  useEffect(() => () => { setPreview((old) => { if (old) URL.revokeObjectURL(old.url); return null; }); }, []);

  const pickDir = async () => {
    const dir = await open({ directory: true, defaultPath: s.dir || undefined });
    if (typeof dir === "string") set("dir", dir);
  };

  const run = async () => {
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: items.length });
    try {
      // the upscale model, downloaded on first use
      if (upscale) {
        const stop = await listen<{ stage: string; mb?: number }>("ai-model", (e) => {
          const p = e.payload;
          setNote(p.stage === "downloading" ? `downloading the upscale model (${p.mb ?? "?"} MB), first use only…`
                : p.stage === "installing" ? "installing the upscale model…" : null);
        });
        try { await invoke("ai_model_ensure", { id: UPSCALE_MODEL }); } finally { stop(); }
        setNote(`AI upscaling ${upscale}×: a few minutes for each photo`);
      }
      // each image's metadata, when its name or its frame's text needs it
      const needMeta = s.naming === "template" || s.texts.length > 0;
      const metas = await Promise.all(items.map(async (i) => !needMeta ? EMPTY_META
        : invoke<{ image: { metadata: Meta } }>("meta", { imgid: i.imgid }).then((r) => r.image.metadata)));
      const stems = items.map((i, k) =>
        s.naming === "original" ? i.filename.replace(/\.[^.]+$/, "")
          : s.naming === "custom" ? `${s.customName.trim()}-${String(k + 1).padStart(3, "0")}`
          : expand(s.template, i, metas[k], k + 1, items.length, s.dateFormat));
      // files already there, or named twice in this export: what to do
      // with each, asked one at a time unless applied to all the rest
      const conflicts: (Choice | null)[] = items.map(() => null);
      if (!toImmich && s.conflict === "ask") {
        const files = await invoke<{ path: string; exists: boolean }[]>("export_existing", {
          items: items.map((i, k) => ({ imgid: i.imgid, stem: stems[k] })),
          dir: s.dir, subfolder: s.useSubfolder ? s.subfolder : null, format: s.format,
        });
        // macOS and Windows file names ignore case
        const seen = new Set<string>();
        const clash = files.map((f) => {
          const key = f.path.toLowerCase(), twice = seen.has(key);
          seen.add(key);
          return f.exists || twice;
        });
        let all: Choice | null = null;
        for (let k = 0; k < items.length; k++) {
          if (!clash[k]) continue;
          if (!all) {
            const path = files[k].path, cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
            const [c, toAll] = await askAbout({
              name: path.slice(cut + 1), dir: path.slice(0, cut), inBatch: !files[k].exists,
              left: clash.slice(k).filter(Boolean).length,
            });
            if (c === "cancel") { setProgress(null); setNote(null); return; }
            if (toAll) all = c;
            conflicts[k] = c;
          } else {
            conflicts[k] = all;
          }
        }
      }
      const r = await invoke<Result>("export_images", {
        items: items.map((i, k) => ({ imgid: i.imgid, stem: stems[k], created: i.exif.datetime || null,
                                      conflict: conflicts[k] ?? (s.conflict === "ask" ? "unique" : null),
                                      frame: frameFor(s, i, metas[k]) })),
        options: {
          dir: s.dir,
          subfolder: s.useSubfolder ? s.subfolder : null,
          format: s.format,
          quality: s.format === "jpeg" || s.format === "webp" ? s.quality : null,
          bpp: s.format === "tiff" || s.format === "png" ? s.bpp : null,
          colorSpace: s.colorSpace,
          longEdge,
          upscale: upscale || null,
          aiProvider: upscale ? loadAccel().provider : null,
          aiDevice: upscale ? loadAccel().device : null,
          conflict: s.conflict === "ask" ? "unique" : s.conflict,
          immichAlbum: toImmich ? s.album : null,
          location: !s.removeLocation,
          keywords: s.keywords,
          keywordsOnOriginal: s.keywordsOnOriginal,
        },
      });
      setResult(r);
      if (s.keywordsOnOriginal && s.keywords.length) onKeywordsChanged?.();
      setNote(null);
      if (s.reveal && !toImmich && r.written.length) void revealItemInDir(r.written).catch(() => {});
      // a clean export needs no reading; anything skipped or failed stays up
      if (!r.failed.length && !r.skipped.length) setTimeout(onClose, 900);
    } catch (e) {
      setError(String(e));
      setProgress(null);
      setNote(null);
    }
  };

  const canRun = (toImmich ? !!s.album && albums?.some((a) => a.id === s.album) : !!s.dir) && items.length > 0 && !busy
    && (s.naming !== "custom" || !!s.customName.trim()) && (s.naming !== "template" || !!s.template.trim());

  const conflictNames = { ask: "Ask me", unique: "Add a number", overwrite: "Replace it", skip: "Skip it" };
  const formatNames = { jpeg: "JPEG", tiff: "TIFF", png: "PNG", webp: "WebP" };
  const spaceNames = { srgb: "sRGB", adobergb: "Adobe RGB (1998)", displayp3: "Display P3", prophoto: "ProPhoto RGB" };

  const presetRow = (p: ExportPreset) => {
    const Icon = presetIcon(p);
    return (
      <li key={p.id} className={p.id === presetId ? "on" : ""}>
        {naming?.id === p.id ? (
          <input className="field" autoFocus value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                 onBlur={finishNaming} onKeyDown={(e) => { if (e.key === "Enter") finishNaming(); }} />
        ) : (
          <button onClick={() => applyPreset(p)} onDoubleClick={() => !p.builtin && setNaming({ id: p.id, name: p.name })}
                  title={p.builtin ? undefined : "double-click to rename"}>
            {p.builtin ? <Icon className="icon" strokeWidth={1.7} /> : (
              // a preset of the user's: its icon is theirs to choose
              <span className={`icon-pick${iconFor === p.id ? " on" : ""}`} role="button" title="choose an icon"
                    onClick={(e) => { e.stopPropagation(); setIconFor(iconFor === p.id ? null : p.id); }}
                    onDoubleClick={(e) => e.stopPropagation()}>
                <Icon className="icon" strokeWidth={1.7} />
              </span>
            )}
            <span className="name">{p.name}{p.id === presetId && edited && <span className="edited"> (edited)</span>}</span>
          </button>
        )}
        {iconFor === p.id && (
          <div className="icon-picker">
            {Object.entries(PRESET_ICONS).map(([name, I]) => (
              <button key={name} className={`tool${p.icon === name ? " on" : ""}`} title={name}
                      onClick={() => setIcon(p.id, name)}><I className="icon" strokeWidth={1.7} /></button>
            ))}
            <button className={`auto${p.icon ? "" : " on"}`} onClick={() => setIcon(p.id, null)}
                    title="pick one from what the preset does">Automatic</button>
          </div>
        )}
      </li>
    );
  };
  const unsaved = !!chosen && !chosen.builtin && edited;
  const group = (id: "builtin" | "mine", title: string, body: React.ReactNode) => {
    const shut = closedGroups.has(id) && !(id === "mine" && naming?.id === null);
    return (
      <>
        <button className="group-head" onClick={() => toggleGroup(id)}>{title}<Chevron open={!shut} /></button>
        <Collapse open={!shut}>{body}</Collapse>
      </>
    );
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal export">
        <div className="modal-head">
          <h2>Export</h2>
        </div>

        <div className="export-columns">
          <nav className="export-presets">
            <div className="preset-tools">
              <button className="tool" title="new preset from the settings as they are now"
                      onClick={() => setNaming({ id: null, name: "" })}><Plus className="icon" strokeWidth={1.8} /></button>
              <button className={`tool${unsaved ? " dirty" : ""}`} disabled={!unsaved}
                      title={unsaved ? `save the changes to “${chosen!.name}”` : "save changes to the chosen preset"}
                      onClick={() => storePresets(presets.map((p) => p.id === chosen!.id ? { ...p, settings: presetOf(s) } : p))}>
                <Save className="icon" strokeWidth={1.8} /></button>
              <button className="tool" title="import presets from a file" onClick={() => void importPresets()}>
                <FileDown className="icon" strokeWidth={1.8} /></button>
              <button className="tool" disabled={!chosen}
                      title={chosen ? `save “${chosen.name}” as a file to share` : "export the chosen preset to a file"}
                      onClick={() => void exportPreset()}><Share className="icon" strokeWidth={1.8} /></button>
              <button className="tool delete" disabled={!chosen || chosen.builtin}
                      title={chosen && !chosen.builtin ? `delete “${chosen.name}”` : "delete the chosen preset"}
                      onClick={() => { storePresets(presets.filter((p) => p.id !== presetId)); choosePreset(null); }}>
                <Trash className="icon" strokeWidth={1.8} /></button>
            </div>
            <div className="presets-scroll">
              {group("builtin", "Built-in", <ul>{BUILTINS.map(presetRow)}</ul>)}
              {group("mine", "My Presets", <ul>
                {presets.map(presetRow)}
                {naming && naming.id === null && (
                  <li className="on">
                    <input className="field" autoFocus placeholder="preset name" value={naming.name}
                           onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                           onBlur={finishNaming} onKeyDown={(e) => { if (e.key === "Enter") finishNaming(); }} />
                  </li>
                )}
                {!presets.length && !naming && <li className="empty">+ keeps the settings as they are now</li>}
              </ul>)}
            </div>
          </nav>

          <div className="modal-body export-sections">
            <Section title="Destination" open={openSections.destination} onToggle={(alt) => toggle("destination", alt)}
                     summary={toImmich ? `Immich: ${albums?.find((a) => a.id === s.album)?.name ?? "no album chosen"}`
                       : s.dir ? s.dir.split(/[/\\]/).pop() : "no folder chosen"}>
              <div className="row">
                <span className="k">Save to</span>
                <div className="segmented small">
                  <button className={!toImmich ? "active" : ""} onClick={() => set("target", "folder")}>Folder</button>
                  <button className={toImmich ? "active" : ""} onClick={() => set("target", "immich")}>Immich album</button>
                </div>
              </div>
              {!toImmich ? (
                <>
                  <div className="row">
                    <span className="k">Folder</span>
                    <button className="folder" onClick={pickDir}><span>{s.dir || "Choose a folder…"}</span></button>
                  </div>
                  <label className="row check">
                    <input type="checkbox" checked={s.useSubfolder} onChange={(e) => set("useSubfolder", e.target.checked)} />
                    Inside a new folder
                    <input className="field" value={s.subfolder} disabled={!s.useSubfolder}
                           onChange={(e) => set("subfolder", e.target.value)} />
                  </label>
                  <div className="row">
                    <span className="k">If a file exists</span>
                    <select value={s.conflict} onChange={(e) => set("conflict", e.target.value as Settings["conflict"])}>
                      {Object.entries(conflictNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <label className="row check">
                    <input type="checkbox" checked={s.reveal} onChange={(e) => set("reveal", e.target.checked)} />
                    Show in {FILE_MANAGER} when done
                  </label>
                </>
              ) : (
                <>
                  <div className="row">
                    <span className="k">Album</span>
                    {newAlbum === null ? (
                      <>
                        <select value={albums?.some((a) => a.id === s.album) ? s.album : ""} disabled={!albums}
                                onChange={(e) => set("album", e.target.value)}>
                          <option value="" disabled>{albums ? "Choose an album…" : "loading…"}</option>
                          {albums?.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.count})</option>)}
                        </select>
                        <button className="btn small" disabled={!albums} onClick={() => setNewAlbum("")}>New album…</button>
                      </>
                    ) : (
                      <>
                        <input className="field" autoFocus placeholder="album name" value={newAlbum}
                               onChange={(e) => setNewAlbum(e.target.value)}
                               onKeyDown={(e) => { if (e.key === "Enter") void createAlbum(); }} />
                        <button className="btn small" disabled={!newAlbum.trim()} onClick={() => void createAlbum()}>Create</button>
                        <button className="btn small" onClick={() => setNewAlbum(null)}>Cancel</button>
                      </>
                    )}
                  </div>
                  {immichError && <div className="note-plain warn">{immichError}</div>}
                  {missing.length > 0 && (
                    <div className="note-plain warn">the API key lacks {missing.join(", ")}: give it those in Immich,
                      or exporting may fail</div>
                  )}
                  <div className="note-plain">a photo Immich already has goes into the album without a second copy</div>
                </>
              )}
            </Section>

            <Section title="File Name" open={openSections.name} onToggle={(alt) => toggle("name", alt)}
                     summary={s.naming === "original" ? "same as original" : s.naming === "custom"
                       ? `${s.customName || "name"}-001` : s.template}>
              <div className="row">
                <span className="k">Name</span>
                <select value={s.naming} onChange={(e) => set("naming", e.target.value as Settings["naming"])}>
                  <option value="original">Same as original</option>
                  <option value="custom">Custom name + number</option>
                  <option value="template">Built from photo info</option>
                </select>
              </div>
              {s.naming === "custom" && (
                <div className="row">
                  <span className="k">Custom name</span>
                  <input className="field" placeholder="name" value={s.customName}
                         onChange={(e) => set("customName", e.target.value)} />
                </div>
              )}
              {s.naming === "template" && (
                <>
                  <div className="row">
                    <span className="k">Pattern</span>
                    <input className="field" value={s.template} onChange={(e) => set("template", e.target.value)} />
                  </div>
                  <div className="row">
                    <span className="k" />
                    <select className="token-menu" value="" onChange={(e) => {
                      if (e.target.value) set("template", `${s.template}{${e.target.value}}`);
                    }}>
                      <option value="">Insert photo info…</option>
                      {TOKENS.map((t) => <option key={t} value={t}>{FILE_TOKEN_NAMES[t] ?? t}</option>)}
                    </select>
                  </div>
                  <div className="row">
                    <span className="k">Date style</span>
                    <select value={s.dateFormat} onChange={(e) => set("dateFormat", e.target.value)}>
                      {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                </>
              )}
              {shownImage && s.naming !== "original" && (
                <div className="example">e.g. {s.naming === "custom" ? `${s.customName.trim() || "name"}-001`
                  : expand(s.template, shownImage, previewMeta?.meta ?? EMPTY_META, 1, items.length || 1, s.dateFormat)}
                  .{ext(s.format)}</div>
              )}
            </Section>

            <Section title="Format & Size" open={openSections.format} onToggle={(alt) => toggle("format", alt)}
                     summary={`${formatNames[s.format]}${s.format === "jpeg" || s.format === "webp" ? ` ${s.quality}` : ""}, `
                       + `${upscale ? `AI ${upscale}×` : canvas ? `canvas ${s.canvasW} × ${s.canvasH}` : s.resize ? `${s.longEdge} px` : "original size"}`}>
              <div className="row">
                <span className="k">Format</span>
                <select value={s.format} onChange={(e) => set("format", e.target.value as Settings["format"])}>
                  {Object.entries(formatNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {(s.format === "jpeg" || s.format === "webp") && (
                <div className="row">
                  <span className="k">Quality</span>
                  <input type="range" min={10} max={100} value={s.quality}
                         onChange={(e) => set("quality", Number(e.target.value))} />
                  <span className="num">{s.quality}</span>
                </div>
              )}
              {(s.format === "tiff" || s.format === "png") && (
                <div className="row">
                  <span className="k">Bit depth</span>
                  <select value={s.bpp} onChange={(e) => set("bpp", Number(e.target.value) as 8 | 16)}>
                    <option value={8}>8 bit</option>
                    <option value={16}>16 bit</option>
                  </select>
                </div>
              )}
              <div className="row">
                <span className="k">Size</span>
                <select value={upscale ? `ai${upscale}` : canvas ? "canvas" : s.resize ? "fit" : "original"} onChange={(e) => {
                  const v = e.target.value;
                  setS((old) => {
                    const n: Settings = { ...old, resize: v === "fit", canvas: v === "canvas",
                                          upscale: v === "ai2" ? 2 : v === "ai4" ? 4 : 0 };
                    saveSettings(n);
                    return n;
                  });
                }}>
                  <option value="original">Original size</option>
                  <option value="fit">Fit long edge to…</option>
                  <option value="canvas">Fixed canvas…</option>
                  {canUpscale && <option value="ai2">AI upscale 2×</option>}
                  {canUpscale && <option value="ai4">AI upscale 4×</option>}
                </select>
                {s.resize && !upscale && (
                  <>
                    <input className="field num-field" type="number" min={16} max={30000} value={s.longEdge}
                           onChange={(e) => set("longEdge", Math.max(16, Number(e.target.value)))} />
                    px
                  </>
                )}
              </div>
              {canvas && (
                <>
                  <div className="row">
                    <span className="k">Canvas</span>
                    <input className="field num-field" type="number" min={16} max={30000} value={s.canvasW}
                           title="Width" onChange={(e) => set("canvasW", Math.max(16, Number(e.target.value)))} />
                    ×
                    <input className="field num-field" type="number" min={16} max={30000} value={s.canvasH}
                           title="Height" onChange={(e) => set("canvasH", Math.max(16, Number(e.target.value)))} />
                    px
                  </div>
                  <div className="row">
                    <span className="k">Color</span>
                    <ColorPick value={s.canvasColor} onChange={(v) => set("canvasColor", v)} />
                  </div>
                  <label className="row check">
                    <input type="checkbox" checked={s.canvasFlip} onChange={(e) => set("canvasFlip", e.target.checked)} />
                    Turn for landscape photos
                  </label>
                  <div className="hint">
                    each photo and its frame are fitted inside the canvas and centered; the rest is the canvas color
                  </div>
                </>
              )}
              {upscale > 0 && (
                <div className="hint">
                  a 20 MP photo becomes {upscale === 2 ? "80" : "320"} MP and takes about
                  {upscale === 2 ? " three" : " four"} minutes, during which editing waits; the model (55 MB) downloads
                  on first use
                </div>
              )}
              <div className="row">
                <span className="k">Color space</span>
                <select value={s.colorSpace} onChange={(e) => set("colorSpace", e.target.value as Settings["colorSpace"])}>
                  {Object.entries(spaceNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </Section>

            <Section title="Frame & Captions" open={openSections.frame} onToggle={(alt) => toggle("frame", alt)}
                     summary={[s.borders.length && "frame", s.inner.length && "keyline",
                               s.texts.length && `${s.texts.length} caption${s.texts.length > 1 ? "s" : ""}`]
                       .filter(Boolean).join(", ") || "none"}>
              <FrameEditor s={s} set={set} />
            </Section>

            <Section title="Keywords" open={openSections.keywords} onToggle={(alt) => toggle("keywords", alt)}
                     summary={s.keywords.length
                       ? s.keywords.map((k) => k.slice(k.lastIndexOf("|") + 1)).join(", ")
                         + (s.keywordsOnOriginal ? " (also originals)" : "")
                       : "none"}>
              <KeywordChips keywords={s.keywords}
                            onRemove={(k) => set("keywords", s.keywords.filter((x) => x !== k))} />
              <KeywordInput attached={new Set(s.keywords)} known={knownKeywords} onAdd={addKeywords} addOnBlur />
              <label className="row check">
                <input type="checkbox" checked={s.keywordsOnOriginal}
                       onChange={(e) => set("keywordsOnOriginal", e.target.checked)} />
                Also add to the original photos
              </label>
              <div className="note-plain">added to each exported file with the photo's own keywords; without the
                box ticked the originals keep only theirs</div>
            </Section>

            <Section title="Privacy" open={openSections.privacy} onToggle={(alt) => toggle("privacy", alt)}
                     summary={s.removeLocation ? "location removed" : "location included"}>
              <label className="row check">
                <input type="checkbox" checked={!s.removeLocation} onChange={(e) => set("removeLocation", !e.target.checked)} />
                Include location (GPS)
              </label>
              <div className="note-plain">camera info, title, caption, creator, copyright and keywords (the photo's
                and those above) are always included; the edit history never is</div>
            </Section>
          </div>

          <div className="export-preview">
            <div className="preview-box">
              {preview ? (
                <img src={preview.url} className={preview.key !== previewKey ? "stale" : ""} alt="" />
              ) : (
                <div className="note-plain">{shownImage ? "rendering…" : "no photo to export"}</div>
              )}
            </div>
            <div className="preview-caption">
              {previewError ? <span className="warn">{previewError}</span>
                : shownImage ? <>{shownImage.filename}{items.length > 1 ? `, first of ${items.length}` : ""}</> : null}
            </div>
          </div>
        </div>

        {progress && (
          <div className="progress">
            <div className="bar" style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
          </div>
        )}
        {result && result.uploaded !== undefined && (
          <div className="summary">
            Uploaded {result.uploaded} of {items.length} to {albums?.find((a) => a.id === s.album)?.name ?? "the album"}
            {result.duplicates ? `, ${result.duplicates} already in Immich (added to the album)` : ""}
            {result.failed.length > 0 && `, ${result.failed.length} failed: ${result.failed[0].error}`}
          </div>
        )}
        {result && result.uploaded === undefined && (
          <div className="summary">
            Exported {result.written.length} of {items.length} to {result.dir}
            {result.skipped.length > 0 && `, skipped ${result.skipped.length} already there`}
            {result.failed.length > 0 && `, ${result.failed.length} failed: ${result.failed[0].error}`}
          </div>
        )}
        {note && busy && <div className="summary">{note}</div>}
        {error && <div className="summary error">{error}</div>}

        <div className="modal-foot">
          <div className="segmented small scope">
            <button className={s.scope === "current" ? "active" : ""} onClick={() => set("scope", "current")}>
              Current image
            </button>
            {selected.length > 1 && (
              <button className={s.scope === "selected" ? "active" : ""} onClick={() => set("scope", "selected")}>
                Selected ({selected.length})
              </button>
            )}
            <button className={s.scope === "shown" ? "active" : ""} onClick={() => set("scope", "shown")}>
              All shown ({shown.length})
            </button>
          </div>
          <button className="btn" disabled={busy} onClick={onClose}>{result ? "Done" : "Cancel"}</button>
          <button className="btn primary" disabled={!canRun} onClick={run}>
            {busy ? `Exporting ${progress!.done}/${progress!.total}…`
                  : `Export ${items.length} image${items.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
      {ask && (
        <div className="modal-backdrop">
          <div className="modal conflict">
            <div className="modal-body">
              <h3>“{ask.name}” {ask.inBatch ? "is named twice in this export" : "already exists"}</h3>
              <div className="note-plain">in {ask.dir}</div>
              {ask.left > 1 && (
                <label className="row check">
                  <input type="checkbox" checked={ask.all} onChange={(e) => setAsk({ ...ask, all: e.target.checked })} />
                  Apply to the other {ask.left - 1} file{ask.left === 2 ? "" : "s"} with a name clash
                </label>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => answer.current?.("cancel", false)}>Cancel</button>
              <button className="btn" onClick={() => answer.current?.("skip", ask.all)}>Skip</button>
              <button className="btn" onClick={() => answer.current?.("overwrite", ask.all)}>Overwrite</button>
              <button className="btn primary" autoFocus onClick={() => answer.current?.("unique", ask.all)}>
                Use Unique Name
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
