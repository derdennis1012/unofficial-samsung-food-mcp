# Hosted Samsung Food connector (`sf host`). See docs/hosted.md.
# Build: docker build -t samsung-food-connector .
FROM node:24-slim

ENV NODE_ENV=production \
    SF_HOST_BIND=0.0.0.0 \
    SF_HOST_PORT=8788 \
    SF_HOST_DATA_DIR=/data \
    SAMSUNG_FOOD_HOME=/data/cache

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY bin ./bin

# The data volume is the only writable path (the compose example runs the root FS read-only). Mode
# 700: database, WAL and schema cache are readable by the service user only (the server also sets
# umask 077). A new named volume takes over this mode on first use.
RUN install -d -m 700 -o node -g node /data
USER node
VOLUME ["/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SF_HOST_PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "src/hosted/main.js"]
CMD ["serve"]
