FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 KANZ_DB=/data/kanz.db
VOLUME /data
EXPOSE 3000
# first start: import the Excel data once if the database is empty, then serve
CMD ["sh","-c","[ -f /data/kanz.db ] || node --disable-warning=ExperimentalWarning server/seed.js; node --disable-warning=ExperimentalWarning server/index.js"]
