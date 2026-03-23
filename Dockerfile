FROM node:20-bullseye AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM node:20-bullseye AS backend-builder

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --include=optional

FROM node:20-bullseye-slim AS runtime

WORKDIR /app/backend

ENV NODE_ENV=production

COPY --from=backend-builder /app/backend/node_modules ./node_modules
COPY backend/ ./
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist
COPY WW_verify_mFa2sncgjTMUS3am.txt /app/WW_verify_mFa2sncgjTMUS3am.txt

EXPOSE 8080

CMD ["npm", "start"]
