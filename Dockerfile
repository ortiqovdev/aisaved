# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg — videodan audio parcha ajratish uchun (musiqa aniqlash tezlashadi)
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# root emas
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
