FROM node:22-slim

# better-sqlite3 wird bei Bedarf aus den Quellen gebaut.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY hub/package.json hub/package-lock.json* ./
RUN npm install --omit=dev

COPY hub/src ./src
COPY hub/public ./public
COPY hub/scripts ./scripts

# Die Plugin-Quellen liegen mit im Image: Der Hub baut daraus das Archiv,
# mit dem sich das WordPress-Plugin selbst aktualisiert.
COPY wordpress-plugin ./wordpress-plugin

ENV NODE_ENV=production PORT=4000 DATA_DIR=/data PLUGIN_DIR=/app/wordpress-plugin/autoblog-connector
VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
