# ---------- Build Stage ----------
FROM node:20 AS builder

WORKDIR /app
COPY backend ./backend

WORKDIR /app/backend
RUN npm install
RUN npm run build

# ---------- Nakama Stage ----------
FROM heroiclabs/nakama:3.21.1

COPY --from=builder /app/backend/modules/build /nakama/data/modules/build

COPY ./backend/config/config.prod.yml /nakama/data/config.yml

ENTRYPOINT ["/bin/sh", "-ecx", "\
/nakama/nakama migrate up --database.address postgres://postgres:eFGggNMsbGdDZzlzZMNNQtSfbSprCdql@postgres.railway.internal:5432/railway && \
exec /nakama/nakama --config /nakama/data/config.yml \
"]