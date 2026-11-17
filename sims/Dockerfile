# syntax=docker/dockerfile:1
#
# One image = the API *and* the built web app (the API serves frontend/dist), so there is a single origin:
# no CORS, and the refresh-token cookie is first-party.   Build context: this folder (sims/).
#   docker build -t sims .

# ---- 1. build the web app -------------------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2. production dependencies only (no embedded-postgres, no dev tooling) ------------------------
FROM node:22-alpine AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ---- 3. runtime ------------------------------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=deps /app/backend/node_modules backend/node_modules
COPY backend/package.json backend/
COPY backend/src backend/src
# only the scripts that make sense in a container: schema/catalogue loader and the (guarded) demo seed
COPY backend/scripts/db-init.js backend/scripts/seed-demo.js backend/scripts/
COPY database database
COPY --from=web /build/frontend/dist frontend/dist
# certificate / photo uploads live here → mount a volume (the named volume inherits this ownership)
RUN mkdir -p backend/uploads && chown -R node:node backend/uploads
USER node
WORKDIR /app/backend
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Create the schema on first start (the loader refuses to touch an existing one) and refresh the catalogue, then serve.
# `exec` replaces the shell with node, so `docker stop`'s SIGTERM reaches the server and it shuts down gracefully.
CMD ["sh", "-c", "node scripts/db-init.js && exec node src/server.js"]
