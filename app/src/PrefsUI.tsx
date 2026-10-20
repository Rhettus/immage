// Preferences' building blocks: a titled card of settings, and a row with
// the setting's name and a short explanation on the left, its control on
// the right
export function PrefCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pref-card">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

export function PrefRow({ label, hint, children }: {
  label: string; hint?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="pref-row">
      <div className="pref-label">
        <span>{label}</span>
        {hint && <span className="pref-hint">{hint}</span>}
      </div>
      <div className="pref-control">{children}</div>
    </div>
  );
}

// an on/off setting
export function PrefSwitch({ checked, onChange, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return <input type="checkbox" className="switch" checked={checked} disabled={disabled}
                onChange={(e) => onChange(e.target.checked)} />;
}
