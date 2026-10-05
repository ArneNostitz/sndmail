FROM node:22-alpine
ARG SOURCE_COMMIT=unknown
ENV APP_VERSION=$SOURCE_COMMIT
WORKDIR /app
COPY package.json server.mjs ./
RUN npm install --omit=dev
RUN addgroup -S snd && adduser -S snd -G snd && mkdir -p /data && chown -R snd:snd /app /data
USER snd
EXPOSE 8787
CMD ["node", "server.mjs"]
