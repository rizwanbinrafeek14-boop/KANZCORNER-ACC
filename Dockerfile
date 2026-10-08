FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 KANZ_DB=/data/kanz.db
VOLUME /data
EXPOSE 3000
CMD ["node","--disable-warning=ExperimentalWarning","server.js"]
