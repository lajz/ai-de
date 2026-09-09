# @fde/web

A thin, read-only Next.js (App Router) view over [`@fde/api`](../api). M1's
functional payoff: browse engagements, read the extracted facts with their source
citations, and ask a single-engagement question (pgvector retrieval → authz gate
→ decrypt post-gate → answer, all in the API).

## Pages

| Route               | Shows                                                    |
| ------------------- | -------------------------------------------------------- |
| `/`                 | engagements visible to the caller (`GET /engagements`)   |
| `/engagements/[id]` | fact list (`GET /engagements/:id/facts`) + the Ask panel |
| `POST /api/qa`      | same-origin proxy → `POST /engagements/:id/qa`           |

No design polish, no client-side auth. Every API call is proxied **server-side**
so the session token never reaches the browser bundle.

## Auth

The app reuses `@fde/api`'s WorkOS session cookie (`fde_session`) — it expects to
be served same-site with the API. The "Sign in" link points straight at the
API's `/auth/login`; there is no login UI here.

**Local dev** (API on `:3000`, web on `:3001` — different origins, so the cookie
is not shared): mint a token by running the API's `/auth` flow directly, then set

```
DEV_SESSION_TOKEN=<token>
```

## Env

| Var                 | Default                 | Purpose                         |
| ------------------- | ----------------------- | ------------------------------- |
| `API_BASE_URL`      | `http://localhost:3000` | `@fde/api` base URL             |
| `DEV_SESSION_TOKEN` | –                       | dev-only session token fallback |

## Run

```
pnpm --filter @fde/web dev     # http://localhost:3001
```
