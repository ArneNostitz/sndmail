FROM node:22-alpine
ARG SOURCE_COMMIT=unknown
ENV APP_VERSION=$SOURCE_COMMIT
WORKDIR /app
COPY package.json server.mjs ./
RUN npm install --omit=dev
RUN addgroup -S sndmail && adduser -S sndmail -G sndmail && mkdir -p /data && chown -R sndmail:sndmail /app /data
USER sndmail
EXPOSE 8787
CMD ["node", "server.mjs"]
