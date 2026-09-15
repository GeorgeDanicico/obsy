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

## Run in Docker

The image uses Next.js standalone output, a multi-stage build, Alpine Node, and a non-root runtime user. Application definitions are not included in the image: Docker ignores the `config/` directory during the build, and Compose mounts the file into `/etc/obsy/apps.json` at runtime.

For a config file stored outside this repository, set `OBSY_APPS_CONFIG_FILE` to its host path:

```bash
OBSY_APPS_CONFIG_FILE=/opt/obsy/apps.json docker compose up --build
```

If `OBSY_APPS_CONFIG_FILE` is omitted, Compose uses `./config/apps.json` as a local-development default. You can copy `config/apps.example.json` to that location and adjust it, or provide any other readable JSON file from the host.

The Docker socket is mounted read-only so the collector can run `docker inspect` and `docker stats`. The example also mounts the host's `/proc` and `/` read-only so the resource cards measure the VPS rather than only the Obsy container. On a remote VPS, expose only port 3000 behind your existing reverse proxy and add authentication before making the dashboard public.
