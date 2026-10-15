# syntax=docker/dockerfile:1
ARG NODE_VERSION=24
ARG PNPM_VERSION=12.11.2

FROM node:${NODE_VERSION}-slim AS pnpm
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM pnpm AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM pnpm AS deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# La configuración llega por --env-file y la clave de la GitHub App por volumen (ver deploy/activate.sh).
USER node
CMD ["node", "dist/index.js"]
