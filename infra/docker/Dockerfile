# The platform's three images, from one file: --target api, worker or workbench. Build from the repository root:
#   docker build -f infra/docker/Dockerfile --target api -t astra-api .
FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Every dependency, installed from the lock file before the source is copied, so it is cached between builds.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/workbench/package.json apps/workbench/
COPY packages/agents/package.json packages/agents/
COPY packages/billing/package.json packages/billing/
COPY packages/card/package.json packages/card/
COPY packages/contracts/package.json packages/contracts/
COPY packages/documents/package.json packages/documents/
COPY packages/plans/package.json packages/plans/
COPY packages/platform/package.json packages/platform/
COPY packages/policies/package.json packages/policies/
COPY packages/rating/package.json packages/rating/
COPY packages/studio/package.json packages/studio/
COPY packages/underwriting/package.json packages/underwriting/
RUN npm ci --no-audit --no-fund

FROM deps AS source
COPY tsconfig*.json ./
COPY packages packages
COPY apps apps
COPY db db

# ------------------------------------------------------------------ API and worker
FROM source AS build-services
RUN npm run build -w @astra/api -w @astra/worker && npm prune --omit=dev --no-audit --no-fund

FROM base AS api
ENV NODE_ENV=production
COPY --from=build-services /app/node_modules node_modules
COPY --from=build-services /app/package.json ./
COPY --from=build-services /app/apps/api/package.json ./package.api.json
COPY --from=build-services /app/apps/api/dist dist
COPY db db
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build-services /app/node_modules node_modules
COPY --from=build-services /app/package.json ./
COPY --from=build-services /app/apps/worker/dist dist
USER node
EXPOSE 4100
CMD ["node", "dist/main.js"]

# ------------------------------------------------------------------ Workbench
FROM source AS build-workbench
# The identity provider's address is part of the content security policy, which is fixed at build time.
ARG OIDC_ISSUER
ENV OIDC_ISSUER=$OIDC_ISSUER
RUN npm run build -w @astra/workbench && npm prune --omit=dev --no-audit --no-fund

FROM base AS workbench
ENV NODE_ENV=production
COPY --from=build-workbench /app/node_modules node_modules
COPY --from=build-workbench /app/package.json ./
COPY --from=build-workbench /app/packages packages
COPY --from=build-workbench /app/apps/workbench apps/workbench
WORKDIR /app/apps/workbench
USER node
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "--port", "3000"]
