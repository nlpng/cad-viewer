# syntax=docker/dockerfile:1

# ---- Stage 1: fetch the vendored front-end libs --------------------------------
# vendor/ (~41 MB three.js + occt-import-js) is gitignored and produced by
# tools/fetch_vendor.sh, so we regenerate it at build time rather than relying on
# it being present in the build context. This keeps the image reproducible from a
# clean `git clone`.
FROM python:3.12-slim AS vendor

# Tools needed by tools/fetch_vendor.sh (tar ships in the base image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        file \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY tools/ ./tools/
# Produces /build/vendor/. gltfpack inside the script is best-effort and not
# required at runtime, so a failure there does not break the build.
RUN bash tools/fetch_vendor.sh

# ---- Stage 2: runtime ----------------------------------------------------------
FROM python:3.12-slim AS runtime

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 appuser
WORKDIR /app

# Application source (no build step — served as-is by serve.py).
COPY index.html serve.py ./
COPY css/ ./css/
COPY js/ ./js/
COPY tools/ ./tools/

# Vendored libraries fetched in the previous stage.
COPY --from=vendor /build/vendor ./vendor

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# serve.py defaults to 127.0.0.1; inside the container it must listen on all
# interfaces to be reachable from the host's published port.
ENV HOST=0.0.0.0

# serve.py derives its root from __file__, so it runs unchanged in the container.
# No curl in the runtime image, so probe with Python.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["python3", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/', timeout=4).status == 200 else 1)"]

CMD ["python3", "serve.py", "8000"]
