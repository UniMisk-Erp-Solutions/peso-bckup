# PesoWise migration API (scaffold)

Server-side replacement for Supabase PostgREST/Auth/Storage. **Not deployed to production.**

## Env (names only — set on server, never in Vite)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | staging/prod API | PostgreSQL (migration v2 or cutover DB) |
| `SESSION_SECRET` | prod | Cookie signing |
| `FRONTEND_ORIGIN` | prod | CORS |
| `FORBIDDEN_SUPABASE_HOST` | migration staging | Safety: refuse prod Supabase URL |
| `HOST` / `PORT` | optional | Bind (default `127.0.0.1:8787`) |

## Local

```bash
cd backend
npm install
npm run dev
```

`GET /health`, `GET /ready`

Next: `auth/`, `routes/expenses`, storage signed URLs, SSE events.
