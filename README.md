# Obsy

Obsy is a small Next.js dashboard for VPS resources and Docker workloads. It polls the server-side `/api/metrics` endpoint every five seconds and keeps the browser payload to one current snapshot.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.
To load the repository's local example configuration, run `OBSY_APPS_CONFIG_PATH=./config/apps.json npm run dev`.

## Configure observed applications

Set `OBSY_APPS_CONFIG` to a JSON array or point `OBSY_APPS_CONFIG_PATH` at a JSON file. The file uses this shape:

```json
[
  {
    "id": "web",
    "name": "Web app",
    "container": "my-web",
    "port": 3000,
    "healthUrl": "http://host.docker.internal:3000/health"
  }
]
```

`healthUrl` is optional. When present, Obsy performs a short HTTP probe and marks a running container as degraded when the endpoint does not respond successfully. Without it, Docker's healthcheck (when configured) is used; a running container without a healthcheck is treated as live.

## Logs API

`GET /api/logs?container=<app id>` returns a container's recent log lines (newest first) by running `docker logs` through the same read-only socket, and `GET /api/logs/stream?container=<app id>` follows them as Server-Sent Events. `container` is always an app `id` from the config above, never a container name. `GET /api/logs?requestId=<id>` without `container` searches every configured container over the last 3 days, so give each container you want searched its own entry (for example a worker next to its web app):

```json
{ "id": "expense-tracker-worker", "name": "Expense Tracker worker", "container": "expense-tracker-web-worker" }
```

Other parameters: `since` (`15m`, `1h`, `3d`, `today`, or an ISO time with a zone; default `1h`, at most 7 days back), `until` (ISO time), `level` (lowest of `debug`, `info`, `warn`, `error`), `q` (text, at most 100 characters), `requestId`, `event`, and `limit` (default 500, at most 2000). At most 2 reads run at once (a few more wait, the rest get 429), each for at most 10 seconds, and at most 3 live tails, each for at most 15 minutes. Log lines carry user ids: keep Obsy bound to localhost or behind authentication.

## Logs page

`/logs` (in the sidebar, and from each container's details on the Applications tab) reads the Logs API above. Pick an app, a level, a time range (15 min, 1 hour, today, 3 days), search the text, or paste a request id (the code after `ref` in an app error message) to search every configured app over the last 3 days. Click a row to see its JSON and its spans, slowest first; a request id in a row searches for that id. The filters live in the URL, so a link to a search can be shared: `/logs?container=<app id>&since=1h&level=warn&q=text&requestId=<id>&live=1`. The Live switch follows one app's new lines (newest on top, at most 1000 kept, pause and resume available); it closes after 15 minutes, when the server ends it, or when the tab has been hidden for a minute.

## Metrics from the logs

`GET /api/logs/metrics` (every configured app) or `GET /api/logs/metrics?container=<app id>` computes simple numbers from the last 15 minutes of an app's lines, with one `docker logs --since 15m` read per app. The read goes through the same limits as the Logs API, one read per app runs at a time (callers that arrive together share it), and its result is kept for 30 seconds. A read that fails (Docker down, too many reads at once) gives `{ "ok": false, "error": … }` for that app, never an error for the whole reply.

- **Requests** (only for apps whose lines include `request` lines; other apps show nothing): requests per minute (the 15-minute count divided by 15), error rate (status 500 or above, as a share of requests), the number of 429 responses, and p50 and p95 of `ms`, overall and per route template. Percentiles use the nearest-rank method: with `n` sorted values, the p-th percentile is the value at rank `ceil(p / 100 * n)`. Routes with fewer than 5 requests are pooled into one `other` row. An app that has written request lines since Obsy started keeps showing zeros when it is quiet.
- **Worker heartbeat:** time since the newest `tick` line, red after 3 tick intervals (90 seconds; the worker ticks every 30 seconds). A worker is any configured app whose lines include `tick` events, so it needs its own entry in the apps config (the Expense Tracker one is the example under "Logs API" above). Without one, the Expense Tracker card says so instead of showing a heartbeat. A worker silent for the whole 15 minutes leaves nothing to recognise it by, so one whose id or container name contains `worker` shows a red "No tick in 15 min" instead.

They show on an app's card under Applications and as a per-route table at the top of `/logs` for the selected app, and refresh every 15 seconds (a cached read is not repeated).

## Run in Docker

The image uses Next.js standalone output, a multi-stage build, Alpine Node, and a non-root runtime user. Application definitions are not included in the image: Docker ignores the `config/` directory during the build, and Compose mounts the file into `/etc/obsy/apps.json` at runtime.

For a config file stored outside this repository, set `OBSY_APPS_CONFIG_FILE` to its host path:

```bash
OBSY_APPS_CONFIG_FILE=/opt/obsy/apps.json docker compose up --build
```

If `OBSY_APPS_CONFIG_FILE` is omitted, Compose uses `./config/apps.json` as a local-development default. You can copy `config/apps.example.json` to that location and adjust it, or provide any other readable JSON file from the host.

The Docker socket is mounted read-only so the collector can run `docker inspect` and `docker stats`. The example also mounts the host's `/proc` and `/` read-only so the resource cards measure the VPS rather than only the Obsy container. On a remote VPS, expose only port 3000 behind your existing reverse proxy and add authentication before making the dashboard public.
