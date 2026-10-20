// Lightroom's Keywording panel: the photo's keywords, a box to add new or
// known ones, and the recently used ones a click away. keywords are
// darktable's tags, "|" between the levels of a hierarchy; the engine keeps
// them in the sidecar and remembers every one ever used
import { useEffect, useMemo, useRef, useState } from "react";

const RECENT_KEY = "immage.recentKeywords";
const RECENT_MAX = 9;

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
  } catch { return []; }
}
function storeRecent(v: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(v)); } catch { /* not kept */ }
}

// what was typed as darktable's tag: Lightroom's "Places > Paris" or
// darktable's "Places|Paris", each level trimmed
export function parseKeyword(typed: string): string {
  return typed.split(/[>|]/).map((p) => p.trim()).filter(Boolean).join("|");
}

const leaf = (k: string) => k.slice(k.lastIndexOf("|") + 1);
const path = (k: string) => k.split("|").join(" > ");

// the box to type keywords in, with the known ones that match below it:
// Enter takes the highlighted suggestion for the last entry, or the text as
// typed; commas separate several
export function KeywordInput({ attached, known, onAdd, addOnBlur = false }: {
  attached: Set<string>;         // keywords already there, not suggested
  known: string[];               // every keyword ever used
  onAdd: (names: string[]) => void;
  // what is typed is added when the box loses focus, as a setting nobody
  // presses Enter for would otherwise be lost
  addOnBlur?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const discarding = useRef(false);   // Escape blurs the box without adding

  // known keywords whose name, or a level of it, starts with what is typed;
  // those whose own name does come first
  const query = draft.split(",").pop()!.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!query) return [];
    const q = parseKeyword(query).toLowerCase();
    const hits = known.filter((k) => !attached.has(k)
      && k.toLowerCase().split("|").some((p) => p.startsWith(q) || k.toLowerCase().startsWith(q)));
    return hits.sort((a, b) => Number(!leaf(a).toLowerCase().startsWith(q)) - Number(!leaf(b).toLowerCase().startsWith(q))
                               || a.localeCompare(b)).slice(0, 8);
  }, [query, known, attached]);
  useEffect(() => setHi(0), [query]);

  const commit = () => {
    const parts = draft.split(",");
    const last = parts.pop()!;
    onAdd([...parts, suggestions[hi] ?? last]);
    setDraft("");
  };

  return (
    <div className="kw-add">
      <input ref={input} className="field" value={draft} placeholder="add keywords, separated by commas"
             onChange={(e) => setDraft(e.target.value)}
             onBlur={() => {
               if (addOnBlur && !discarding.current && draft.trim()) { onAdd(draft.split(",")); setDraft(""); }
               discarding.current = false;
             }}
             onKeyDown={(e) => {
               if (e.key === "Enter") { e.preventDefault(); commit(); }
               else if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); setHi((h) => (h + 1) % suggestions.length); }
               else if (e.key === "ArrowUp" && suggestions.length) {
                 e.preventDefault();
                 setHi((h) => (h + suggestions.length - 1) % suggestions.length);
               }
               else if (e.key === "Escape") { discarding.current = true; setDraft(""); input.current?.blur(); }
             }} />
      {suggestions.length > 0 && (
        <ul className="kw-suggest">
          {suggestions.map((k, i) => (
            <li key={k} className={i === hi ? "hi" : ""}
                onPointerDown={(e) => { e.preventDefault(); onAdd([...draft.split(",").slice(0, -1), k]); setDraft(""); }}>
              <span>{leaf(k)}</span>
              {k.includes("|") && <span className="kw-path">{path(k.slice(0, k.lastIndexOf("|")))}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// the chips of a list of keywords, each taken off with its ×
export function KeywordChips({ keywords, onRemove }: { keywords: string[]; onRemove: (name: string) => void }) {
  return (
    <div className="kw-chips">
      {keywords.length === 0 && <span className="kw-none">no keywords</span>}
      {keywords.map((k) => (
        <span key={k} className="kw-chip" title={path(k)}>
          {leaf(k)}
          <button title={`remove ${path(k)}`} onClick={() => onRemove(k)}>×</button>
        </span>
      ))}
    </div>
  );
}

export function KeywordingPanel({ keywords, known, onAdd, onRemove, open, onToggle }: {
  keywords: string[] | null;     // the open photo's; null while there is none
  known: string[];               // every keyword ever used
  onAdd: (names: string[]) => void;
  onRemove: (name: string) => void;
  open: boolean;
  onToggle: (alt: boolean) => void;
}) {
  const [recent, setRecent] = useState(loadRecent);
  const attached = useMemo(() => new Set(keywords ?? []), [keywords]);

  const add = (names: string[]) => {
    const fresh = [...new Set(names.map(parseKeyword).filter(Boolean))];
    if (!fresh.length) return;
    onAdd(fresh.filter((k) => !attached.has(k)));
    const next = [...fresh, ...recent.filter((k) => !fresh.includes(k))].slice(0, RECENT_MAX);
    setRecent(next);
    storeRecent(next);
  };

  if (!keywords) return null;
  return (
    <div className="panel keywording">
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>Keywording</span>
        <svg className={`chevron${open ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>
      </div>
      {open && (
        <div className="kw-body">
          <KeywordChips keywords={keywords} onRemove={onRemove} />
          <KeywordInput attached={attached} known={known} onAdd={add} />
          {recent.length > 0 && (
            <>
              <div className="kw-label">Recent keywords</div>
              <div className="kw-recent">
                {recent.map((k) => (
                  <button key={k} className={attached.has(k) ? "on" : ""} title={path(k)}
                          onClick={() => (attached.has(k) ? onRemove(k) : add([k]))}>{leaf(k)}</button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
