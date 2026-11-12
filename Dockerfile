FROM node:26-bookworm-slim AS web
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
WORKDIR /repo/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npx vite build

FROM node:26-bookworm-slim AS api
WORKDIR /repo/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim
ENV NODE_ENV=production
ENV WEB_DIST=/app/web
WORKDIR /app
COPY --from=api /repo/backend/node_modules ./node_modules
COPY --from=api /repo/backend/dist ./dist
COPY backend/package.json backend/openapi.yaml ./
COPY backend/db ./db
COPY --from=web /repo/frontend/dist ./web
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
