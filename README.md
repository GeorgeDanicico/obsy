# Obsy

Obsy is a small Next.js dashboard for VPS resources and Docker workloads. It polls the server-side `/api/metrics` endpoint every five seconds and keeps the browser payload to one current snapshot.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Configure observed applications

Set `OBSY_APPS_CONFIG` to a JSON array or mount a JSON file and set `OBSY_APPS_CONFIG_PATH`. The file uses this shape:

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

## Run in Docker

The image uses Next.js standalone output, a multi-stage build, Alpine Node, and a non-root runtime user. Copy `config/apps.example.json` to `config/apps.json`, adjust it, then:

```bash
docker compose -f docker-compose.example.yml up --build
```

The Docker socket is mounted read-only so the collector can run `docker inspect` and `docker stats`. The example also mounts the host's `/proc` and `/` read-only so the resource cards measure the VPS rather than only the Obsy container. On a remote VPS, expose only port 3000 behind your existing reverse proxy and add authentication before making the dashboard public.
