// masks sharing instances, as Lightroom's local adjustments add up rather
// than chain. on a merged map (manifest.ts, `merge`), masks share an
// instance under a combined mask (the engine's `combine`), where each
// mask's group counts at its share of the instance's strength. a frame
// then runs the module once per shared instance, not once per mask: a
// drag on the newest of ten masks went from about 350 ms a draft frame to
// 110-140 (benchmarking/bench.py, masks).
// each mask keeps its own instance of the module, switched off, holding
// its settings for reading back. range components and refinements live in
// an instance's blend parameters, so masks share only with masks that have
// the same ones, which the shared instance then carries. some cannot share
// at all (canMerge()) and keep their own instance on, as every mask did
// before
import { localControlById, localMaps, choiceOn, type ImageContext, type Params, type Values } from "./manifest";
import { isRange, isRefined, maskAt, NO_REFINE, type Mask, type Range, type Refine, type Shape } from "./masks";

export type Member = { mask: string; opacity: number; invert: boolean };
// `group` is the combined mask's name, `instance` the shared instance's.
// `ranges` go with the combined mask, `refine` with the instance
export type Shared = { op: string; group: string; instance: string; params: Params; members: Member[];
                       ranges: Range[]; refine: Refine };
// `merged`: per mask, the ops whose own instance stays off
export type MergePlan = { merged: Map<string, Set<string>>; shared: Shared[] };

export const SHARED_PREFIX = "immage local: ";

// darktable inverts a drawn mask and its ranges as a whole, which a member
// of a sum cannot be; ranges alone have no drawn mask to be a member with;
// and refine Contrast curves the mask before the instance's opacity, which
// a member's would have to come before
export const canMerge = (m: Mask) => {
  const ranged = m.shapes.some(isRange);
  return !(ranged && (m.invert || m.shapes.every(isRange))) && !(m.refine?.contrast ?? 0);
};

// what the instance carries for a mask besides its settings: masks share
// only when it is the same
const blendKey = (m: Mask) =>
  JSON.stringify([m.shapes.filter(isRange), isRefined(m) ? m.refine : null]);

// directions compare on a grid finer than any slider's step
const key = (v: number) => Math.round(v * 1e4) / 1e4;

// where a mask covers the image, coarsely: maskAt() on a grid, kept for as
// long as the mask's shapes are the same
const GRID_W = 48, GRID_H = 32;
const grids = new WeakMap<Shape[], Map<boolean, Float32Array>>();
function grid(m: Mask, aspect: number): Float32Array {
  const byInvert = grids.get(m.shapes) ?? new Map<boolean, Float32Array>();
  grids.set(m.shapes, byInvert);
  const hit = byInvert.get(m.invert);
  if (hit) return hit;
  const g = new Float32Array(GRID_W * GRID_H);
  try {
    for (let j = 0; j < GRID_H; j++)
      for (let i = 0; i < GRID_W; i++)
        g[j * GRID_W + i] = maskAt(m, (i + 0.5) / GRID_W, (j + 0.5) / GRID_H, 1000 * aspect, 1000, null);
  } catch {
    // an AI object's outline needs a canvas (none outside the page): taken
    // as covering everything, which errs toward the members' sum
    g.fill(1);
  }
  byInvert.set(m.invert, g);
  return g;
}

type Entry = { m: Mask; mag: number };
type Group = { values: Values; mag: number; list: Entry[]; blend: Mask };

// the most the members add up to anywhere, each at its strength and amount
function peak(list: Entry[], aspect: number): number {
  const sum = new Float32Array(GRID_W * GRID_H);
  for (const { m, mag } of list) {
    const g = grid(m, aspect), w = mag * ((m.opacity ?? 100) / 100);
    for (let k = 0; k < sum.length; k++) sum[k] += w * g[k];
  }
  return Math.max(0, ...sum);
}

export function planMerge(masks: Mask[], values: Values, before: boolean, ctx: ImageContext): MergePlan {
  const merged = new Map<string, Set<string>>();
  const shared: Shared[] = [];
  const aspect = ctx.sensorWidth / Math.max(1, ctx.sensorHeight);
  for (const map of localMaps) {
    if (!map.merge) continue;
    const fixed = map.controls.filter((id) => map.fixed?.includes(id));
    const scaled = map.controls.filter((id) => !map.fixed?.includes(id));
    // two ways to group: masks whose settings point the same way, or one
    // group per control and sign with the mask's other controls at neutral.
    // a photo's masks rarely share a direction once they move two sliders,
    // so the second often needs far fewer instances. in the order of their
    // first mask, so a new mask does not renumber them
    const byDir = new Map<string, Group>(), byAxis = new Map<string, Group>();
    const add = (groups: Map<string, Group>, k: string, m: Mask, mag: number, v: Values) => {
      const g = groups.get(k);
      if (!g) groups.set(k, { values: v, mag, list: [{ m, mag }], blend: m });
      else {
        g.list.push({ m, mag });
        if (mag > g.mag) Object.assign(g, { values: v, mag });
      }
    };
    for (const m of masks) {
      if (!canMerge(m)) continue;
      if (!merged.has(m.name)) merged.set(m.name, new Set());
      merged.get(m.name)!.add(map.op);
      const on = !before && !m.hidden && choiceOn(map, values) && map.controls.some((id) => m.values[id] !== 0);
      if (!on) continue;
      const fk = [blendKey(m), ...fixed.map((id) => key(m.values[id] ?? 0))];
      const s = scaled.map((id) => m.values[id] ?? 0);
      const mag = Math.max(0, ...s.map(Math.abs));
      add(byDir, JSON.stringify([fk, mag ? s.map((v) => key(v / mag)) : null]), m, mag, m.values);
      const own = scaled.filter((id) => (m.values[id] ?? 0) !== 0);
      if (!own.length) add(byAxis, JSON.stringify([fk, null]), m, 0, m.values);
      for (const id of own) {
        const only = { ...m.values, ...Object.fromEntries(scaled.filter((o) => o !== id).map((o) => [o, 0])) };
        add(byAxis, JSON.stringify([fk, id, Math.sign(m.values[id])]), m, Math.abs(m.values[id]), only);
      }
    }
    let n = 0;
    for (const g of (byAxis.size < byDir.size ? byAxis : byDir).values()) {
      const group = `${map.op} ${++n}`;
      // strong enough for where the members add up most, as Lightroom adds
      // overlapping masks; the combined mask stops at 1, so a weaker
      // strength would cap the overlap. no weaker than the strongest member,
      // which a mask alone thereby gets exactly, and no further than the
      // sliders reach: past that, the module's params leave the range
      // darktable declares for them
      const room = Math.min(...scaled.filter((id) => g.values[id]).map((id) => {
        const c = localControlById.get(id)!, v = g.values[id];
        return (g.mag * (v > 0 ? c.max : -c.min)) / Math.abs(v);
      }));
      const full = Math.max(g.mag, Math.min(peak(g.list, aspect), room));
      const v = full !== g.mag && g.mag
        ? Object.fromEntries(Object.entries(g.values).map(([id, x]) => [id, scaled.includes(id) ? (x * full) / g.mag : x]))
        : g.values;
      shared.push({
        op: map.op, group, instance: SHARED_PREFIX + group,
        params: map.write(v, {}, ctx),
        // a mask with only fixed controls moved is at full strength
        members: g.list.map(({ m, mag }) => ({
          mask: m.name, invert: m.invert,
          opacity: ((m.opacity ?? 100) / 100) * (full ? mag / full : 1),
        })),
        ranges: g.blend.shapes.filter(isRange),
        refine: isRefined(g.blend) ? g.blend.refine! : NO_REFINE,
      });
    }
  }
  return { merged, shared };
}
