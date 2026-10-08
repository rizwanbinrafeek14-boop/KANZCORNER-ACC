FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 KANZ_DATA_DIR=/data/pgdata
VOLUME /data
EXPOSE 3000
CMD ["node","--disable-warning=ExperimentalWarning","server.js"]
