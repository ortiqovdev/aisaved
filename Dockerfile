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

# ffmpeg — videodan audio parcha ajratish, dumaloq video, YouTube video+ovozni birlashtirish.
# yt-dlp — YouTube Shorts (python3 kerak). YouTube tez-tez o'zgaradi, shuning uchun
# distributiv paketi emas, rasmiy relizning oxirgi versiyasi olinadi.
RUN apk add --no-cache ffmpeg python3 \
 && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# /privacy sahifasi (Meta App Live rejimi uchun Privacy Policy URL)
COPY docs ./docs

# root emas
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
