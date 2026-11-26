import { useState, type InputHTMLAttributes } from "react";

// A number kept as typed while it is being typed, so "5" on the way to
// "5128" is not clamped to a minimum of 16, nor "-" or "0." lost on the way
// to "-3" or "0.5". A value in range is applied as it is typed; leaving the
// field (or Enter) applies the clamped value and shows the setting again.
export function NumberField({ value, onChange, min = -Infinity, max = Infinity, integer = false, ...rest }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; integer?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type">) {
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (text: string) => {
    const v = integer ? parseInt(text, 10) : parseFloat(text.replace(",", "."));
    return Number.isFinite(v) ? v : null;
  };
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const finish = () => {
    if (draft === null) return;
    const v = parse(draft);
    if (v !== null && clamp(v) !== value) onChange(clamp(v));
    setDraft(null);
  };
  return (
    <input {...rest} type="text" inputMode={integer ? "numeric" : "decimal"} value={draft ?? String(value)}
           onFocus={(e) => { setDraft(String(value)); rest.onFocus?.(e); }}
           onBlur={(e) => { finish(); rest.onBlur?.(e); }}
           onKeyDown={(e) => { if (e.key === "Enter") finish(); rest.onKeyDown?.(e); }}
           onChange={(e) => {
             setDraft(e.target.value);
             const v = parse(e.target.value);
             if (v !== null && v >= min && v <= max) onChange(v);
           }} />
  );
}
