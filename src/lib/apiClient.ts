const baseUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function apiLogout() {
  const res = await apiFetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error(`logout_failed:${res.status}`);
  return res.json();
}

export async function apiLogin(email: string, password: string) {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login_failed:${res.status}`);
  return res.json();
}

export async function apiMe() {
  const res = await apiFetch("/api/auth/me");
  if (!res.ok) throw new Error(`me_failed:${res.status}`);
  return res.json();
}
