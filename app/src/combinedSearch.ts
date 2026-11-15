// Frontend-only coordinator for independent search sources. It deliberately
// knows nothing about Immich or the local index; callers provide both adapters.
export type CombinedSourcePage<T> = { items: T[]; next: string | null };

export type CombinedSourceState<T> = {
  status: "idle" | "searching" | "ready" | "error";
  items: T[];
  next: string | null;
  error: unknown | null;
  loadingMore: boolean;
};

export type CombinedSearchState<TSources extends Record<string, unknown>> = {
  generation: number;
  query: unknown;
  sources: { [K in keyof TSources]: CombinedSourceState<TSources[K]> };
  results: Array<{ item: TSources[keyof TSources]; score: number; sources: Array<keyof TSources> }>;
};

export type CombinedSource<TQuery, TItem> = (query: TQuery, next: string | null, signal: AbortSignal) => Promise<CombinedSourcePage<TItem>>;

type CoordinatorOptions<TQuery, TSources extends Record<string, unknown>> = {
  sources: { [K in keyof TSources]: CombinedSource<TQuery, TSources[K]> };
  onUpdate?: (state: CombinedSearchState<TSources>) => void;
  // Return a key only when identity has been positively verified. Null keeps
  // the result distinct even if other metadata happens to look alike.
  verifiedIdentity?: (source: keyof TSources, item: TSources[keyof TSources]) => string | null;
  rankConstant?: number;
};

const emptySource = <T>(): CombinedSourceState<T> => ({ status: "idle", items: [], next: null, error: null, loadingMore: false });

export function createCombinedSearchCoordinator<TQuery, TSources extends Record<string, unknown>>(
  options: CoordinatorOptions<TQuery, TSources>,
) {
  const keys = Object.keys(options.sources) as Array<keyof TSources>;
  const rankConstant = options.rankConstant ?? 60;
  let generation = 0;
  let controllers = new Map<keyof TSources, AbortController>();
  let currentQuery: TQuery | null = null;
  let state: CombinedSearchState<TSources> = {
    generation, query: null,
    sources: Object.fromEntries(keys.map((key) => [key, emptySource()])) as CombinedSearchState<TSources>["sources"],
    results: [],
  };

  const snapshot = (): CombinedSearchState<TSources> => state;
  const publish = () => { options.onUpdate?.(state); };
  const recompute = () => {
    type Aggregate = { item: TSources[keyof TSources]; score: number; sources: Array<keyof TSources> };
    const ranked: Aggregate[] = [];
    const verified = new Map<string, Aggregate>();
    for (const source of keys) {
      const rows = state.sources[source].items as TSources[keyof TSources][];
      rows.forEach((item, index) => {
        const add = 1 / (rankConstant + index + 1);
        const id = options.verifiedIdentity?.(source, item) ?? null;
        const prior = id === null ? undefined : verified.get(id);
        if (prior) {
          if (!prior.sources.includes(source)) { prior.score += add; prior.sources.push(source); }
        } else {
          const entry: Aggregate = { item, score: add, sources: [source] };
          ranked.push(entry);
          if (id !== null) verified.set(id, entry);
        }
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    state = { ...state, results: ranked };
  };
  const updateSource = (source: keyof TSources, patch: Partial<CombinedSourceState<TSources[keyof TSources]>>) => {
    state = { ...state, sources: { ...state.sources, [source]: { ...state.sources[source], ...patch } } };
    recompute();
    publish();
  };
  const startSource = async (source: keyof TSources, query: TQuery, next: string | null, append: boolean, token: number) => {
    const controller = new AbortController();
    controllers.set(source, controller);
    const before = state.sources[source];
    updateSource(source, { status: "searching", error: null, loadingMore: append, ...(append ? {} : { items: [], next: null }) });
    try {
      const page = await options.sources[source](query, next, controller.signal);
      if (token !== generation || controller.signal.aborted) return;
      updateSource(source, {
        status: "ready", items: append ? [...before.items, ...page.items] : page.items,
        next: page.next, error: null, loadingMore: false,
      });
    } catch (error) {
      if (token !== generation || controller.signal.aborted) return;
      updateSource(source, { status: "error", error, loadingMore: false });
    } finally {
      if (controllers.get(source) === controller) controllers.delete(source);
    }
  };

  return {
    getState: snapshot,
    search(query: TQuery, enabled: Array<keyof TSources> = keys) {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      const token = ++generation;
      currentQuery = query;
      state = {
        generation: token, query,
        sources: Object.fromEntries(keys.map((key) => [key, { ...emptySource(), status: enabled.includes(key) ? "searching" : "idle" }])) as CombinedSearchState<TSources>["sources"],
        results: [],
      };
      publish();
      // Every source publishes through its own completion path; a hung source
      // cannot hold back another source's successful results.
      return Promise.allSettled(keys.filter(key => enabled.includes(key)).map((key) => startSource(key, query, null, false, token)));
    },
    loadMore(source: keyof TSources) {
      if (currentQuery === null) return Promise.resolve();
      const sourceState = state.sources[source];
      if (sourceState.next === null || sourceState.loadingMore || sourceState.status === "searching") return Promise.resolve();
      const cursor = sourceState.next;
      return startSource(source, currentQuery, cursor, true, generation);
    },
    cancel() {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      generation++;
      currentQuery = null;
      state = { ...state, query: null, generation, sources: Object.fromEntries(keys.map(key => [key, { ...state.sources[key], status: state.sources[key].status === "searching" ? "ready" : state.sources[key].status, loadingMore: false }])) as CombinedSearchState<TSources>["sources"] };
      publish();
    },
  };
}
