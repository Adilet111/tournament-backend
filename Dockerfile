FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm ci installs exactly what package-lock.json pins (reproducible builds).
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
# Don't run the API as root inside the container.
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
