FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node prompts ./prompts
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node prompts ./prompts

USER node
EXPOSE 7860
CMD ["npm", "start"]
