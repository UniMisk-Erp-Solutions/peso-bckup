import {
  apiFetch,
  apiLogin,
  apiLogout,
  apiMe,
} from "@/lib/apiClient";
import { migrationApiBaseUrl } from "@/lib/migrationStagingRuntime";

type FilterOp = { col: string; op: "eq" | "in"; val: string };

function buildQuery(table: string, select: string, filters: FilterOp[], limit?: number) {
  const q = new URLSearchParams();
  q.set("select", select || "*");
  for (const f of filters) {
    q.set(`${f.op}.${f.col}`, f.val);
  }
  if (limit != null) q.set("limit", String(limit));
  return `${migrationApiBaseUrl()}/api/data/${table}?${q.toString()}`;
}

class MigrationQueryBuilder {
  private filters: FilterOp[] = [];
  private selectCols = "*";
  private limitN: number | undefined;
  private singleMode: "none" | "maybe" | "single" = "none";

  constructor(private table: string) {}

  select(cols: string) {
    this.selectCols = cols;
    return this;
  }

  eq(col: string, val: string | number | boolean) {
    this.filters.push({ col, op: "eq", val: String(val) });
    return this;
  }

  in(col: string, vals: readonly (string | number)[]) {
    this.filters.push({ col, op: "in", val: vals.map(String).join(",") });
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  maybeSingle() {
    this.singleMode = "maybe";
    return this;
  }

  single() {
    this.singleMode = "single";
    return this;
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.exec().then(onfulfilled, onrejected);
  }

  async exec(): Promise<{ data: unknown; error: unknown }> {
    try {
      const url = buildQuery(this.table, this.selectCols, this.filters, this.limitN);
      const path = url.replace(migrationApiBaseUrl(), "");
      const res = await apiFetch(path, { method: "GET" });
      if (!res.ok) {
        return { data: null, error: { message: `data_${res.status}`, status: res.status } };
      }
      const json = (await res.json()) as { items?: unknown[] };
      let rows = json.items ?? [];
      if (this.singleMode === "maybe") {
        return { data: rows[0] ?? null, error: null };
      }
      if (this.singleMode === "single") {
        if (rows.length !== 1) {
          return { data: null, error: { message: "Cannot coerce the result to a single JSON object" } };
        }
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  }
}

function migrationAuth() {
  let cachedUser: { id: string; email: string } | null = null;

  return {
    async signInWithPassword(credentials: { email: string; password: string }) {
      try {
        const body = await apiLogin(credentials.email, credentials.password);
        cachedUser = { id: body.user.id, email: body.user.email };
        const session = {
          access_token: "migration-session",
          user: { id: body.user.id, email: body.user.email },
        };
        return { data: { user: session.user, session }, error: null };
      } catch (e) {
        return { data: { user: null, session: null }, error: e };
      }
    },
    async signOut() {
      await apiLogout();
      cachedUser = null;
      return { error: null };
    },
    async getSession() {
      try {
        const me = await apiMe();
        cachedUser = { id: me.user.id, email: me.user.email };
        return {
          data: {
            session: {
              access_token: "migration-session",
              user: { id: me.user.id, email: me.user.email },
            },
          },
          error: null,
        };
      } catch {
        cachedUser = null;
        return { data: { session: null }, error: null };
      }
    },
    async getUser() {
      if (cachedUser) {
        return { data: { user: cachedUser }, error: null };
      }
      return this.getSession().then(({ data }) => ({
        data: { user: data.session?.user ?? null },
        error: null,
      }));
    },
    onAuthStateChange(_cb: unknown) {
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
  };
}

export function createMigrationSupabaseStub(): {
  auth: ReturnType<typeof migrationAuth>;
  from: (table: string) => MigrationQueryBuilder;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  storage: { from: () => { createSignedUrl: () => Promise<{ data: null; error: { message: string } }> } };
  channel: () => { subscribe: () => ({ unsubscribe: () => undefined }) };
  removeChannel: () => undefined;
  functions: { invoke: () => Promise<{ data: null; error: { message: string } }> };
} {
  return {
    auth: migrationAuth(),
    from(table: string) {
      return new MigrationQueryBuilder(table);
    },
    async rpc(fn: string, args?: Record<string, unknown>) {
      const res = await apiFetch("/api/rpc/" + encodeURIComponent(fn), {
        method: "POST",
        body: JSON.stringify(args ?? {}),
      });
      if (!res.ok) return { data: null, error: { message: `rpc_${res.status}` } };
      const json = await res.json();
      return { data: json.result ?? json, error: null };
    },
    storage: {
      from() {
        return {
          async createSignedUrl() {
            return { data: null, error: { message: "use_api_storage_routes" } };
          },
        };
      },
    },
    channel() {
      return { subscribe: () => ({ unsubscribe: () => undefined }) };
    },
    removeChannel: () => undefined,
    functions: {
      invoke: async () => ({ data: null, error: { message: "use_api_not_edge_functions" } }),
    },
  };
}
