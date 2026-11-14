// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { open } from "@tauri-apps/plugin-dialog";

export function GridIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" />
    </svg>
  );
}

// outline icons in the style of the rest of the interface
export const icon = (path: React.ReactNode) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round">{path}</svg>
);
export const FolderIcon = () => icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
export const DriveIcon = () => icon(<><rect x="3" y="13" width="18" height="7" rx="2" />
  <path d="M5.5 13 8 5h8l2.5 8" /><path d="M17 16.5h.01" /></>);
export const NetworkIcon = () => icon(<><rect x="3" y="4" width="18" height="7" rx="2" /><path d="M7 7.5h.01" />
  <path d="M12 11v5" /><path d="M4 19h16" /><circle cx="12" cy="19" r="1.5" /></>);
export const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg className="icon" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor"
       strokeWidth="1.6" strokeLinejoin="round">
    <path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 3 1.1-6.2L3 9.7l6.2-.9z" />
  </svg>
);
export const RefreshIcon = () => icon(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" />
  <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>);
export const BanIcon = () => icon(<><circle cx="12" cy="12" r="8.5" /><path d="m6 6 12 12" /></>);
export const SlidersIcon = () => icon(<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
  <circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>);

// the Zone System's gray scale, dark to light
export const ZonesIcon = () => icon(<><rect x="3" y="8" width="18" height="8" rx="1.5" />
  <rect x="3" y="8" width="4.5" height="8" fill="currentColor" stroke="none" />
  <rect x="7.5" y="8" width="4.5" height="8" fill="currentColor" stroke="none" opacity="0.55" />
  <rect x="12" y="8" width="4.5" height="8" fill="currentColor" stroke="none" opacity="0.2" /></>);
// a sticking plaster, Lightroom's Remove tool
export const HealIcon = () => icon(<><rect x="2.8" y="8.2" width="18.4" height="7.6" rx="3.8" transform="rotate(-45 12 12)" />
  <rect x="9.3" y="9.3" width="5.4" height="5.4" rx="0.8" transform="rotate(-45 12 12)" /></>);
// a card going into a tray
export const ImportIcon = () => icon(<><path d="M12 3v11" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
  <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>);
export const GearIcon = () => icon(<><circle cx="12" cy="12" r="3" />
  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
// a pushpin, filled while the panel is pinned open
export const PinIcon = ({ on }: { on: boolean }) => icon(
  <><path d="M9 4h6l-1 6 3 3H7l3-3z" fill={on ? "currentColor" : "none"} /><path d="M12 13v7" /></>);
export const HelpIcon = () => icon(<><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" />
  <path d="M12 17h.01" /></>);
export const KeyboardIcon = () => icon(<><rect x="2.5" y="6" width="19" height="12" rx="2" />
  <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" /></>);
export const LayersIcon = () => icon(<><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>);
export const PresetsIcon = () => icon(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" />
  <rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>);
export const UndoIcon = ({ redo = false }: { redo?: boolean }) => icon(
  <g transform={redo ? "matrix(-1 0 0 1 24 0)" : undefined}>
    <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></g>);
export const BeforeAfterIcon = () => icon(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M12 4.5v15" />
                                      <path d="M12 4.5h6a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-6z" fill="currentColor" /></>);
export const CompareIcon = () => icon(<><rect x="2.5" y="6" width="8.5" height="12" rx="1.5" />
                                  <rect x="13" y="6" width="8.5" height="12" rx="1.5" /></>);
// darktable's module cards, stacked, for the Advanced editing mode
export const ModulesIcon = () => icon(<><rect x="4" y="4" width="16" height="5" rx="1.5" /><rect x="4" y="11" width="16" height="4" rx="1.5" />
  <rect x="4" y="17" width="16" height="3" rx="1.5" /><circle cx="7" cy="6.5" r="0.6" fill="currentColor" /></>);
// two chevrons pointing in to collapse, out to expand
export const FoldIcon = ({ open }: { open: boolean }) => icon(open
  ? <><path d="m7 4 5 5 5-5" /><path d="m7 20 5-5 5 5" /></>
  : <><path d="m7 9 5-5 5 5" /><path d="m7 15 5 5 5-5" /></>);
// a counter-clockwise arrow, the usual sign for back to the defaults
export const ResetIcon = () => icon(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>);
export const PipetteIcon = () => icon(<><path d="m12 9-8.4 8.4a2 2 0 0 0-.6 1.4V21h2.2a2 2 0 0 0 1.4-.6L15 12" />
                                   <path d="m18 9 1.4-1.4a2.1 2.1 0 1 0-3-3L15 6" /><path d="m9 6 9 9" /></>);
// a ruler at a slant, as Lightroom's Straighten tool
export const RulerIcon = () => icon(<g transform="rotate(-35 12 12)"><rect x="2" y="8.5" width="20" height="7" rx="1.2" />
  <path d="M6 8.5v3M10 8.5v2M14 8.5v3M18 8.5v2" /></g>);
// an arrow turning a quarter round, and a frame mirrored across its axis
export const RotateIcon = ({ right = false }: { right?: boolean }) => icon(
  <g transform={right ? undefined : "matrix(-1 0 0 1 24 0)"}>
    <rect x="9" y="10" width="11" height="10" rx="1.5" /><path d="M4 13V9a4 4 0 0 1 4-4h5" /><path d="m10.5 2.5 2.5 2.5-2.5 2.5" /></g>);
export const FlipIcon = ({ vertical = false }: { vertical?: boolean }) => icon(
  <g transform={vertical ? "rotate(90 12 12)" : undefined}>
    <path d="M12 3v18" strokeDasharray="2 2.5" /><path d="M9 6 3 18h6z" /><path d="M15 6l6 12h-6z" fill="currentColor" /></g>);
// a strip of film with its sprocket holes
export const FilmIcon = () => icon(<><rect x="4" y="2.5" width="16" height="19" rx="2" /><path d="M8 2.5v19M16 2.5v19" />
  <path d="M4 7h4M4 12h4M4 17h4M16 7h4M16 12h4M16 17h4" /></>);
// a film canister, its leader drawn out
export const FilmSimIcon = () => icon(<><rect x="3" y="6" width="9" height="13" rx="2" /><path d="M5 6V4h5v2M5 19v2h5v-2" />
  <path d="M12 9h7.5a1.5 1.5 0 0 1 0 3H17v4h-5" /><path d="M14 9v3M16.5 9v3" /></>);
export const CropIcon = () => icon(<><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></>);
export const ExportIcon = () => icon(<><path d="M12 15V4" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
                                  <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></>);
export const PrintIcon = () => icon(<><path d="M7 9V4h10v5" /><rect x="3.5" y="9" width="17" height="7.5" rx="2" />
                                <path d="M7 14h10v6H7z" /></>);
export const FilterIcon = () => icon(<path d="M4 5h16l-6 7.5V19l-4 2v-8.5z" />);
export const PanelIcon = ({ side }: { side: "left" | "bottom" | "right" }) => icon(<>
  <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
  {side === "left" && <path d="M9 4.5v15" />}
  {side === "right" && <path d="M15 4.5v15" />}
  {side === "bottom" && <path d="M3.5 14.5h17" />}
</>);
