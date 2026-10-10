# 构建阶段
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# 运行阶段：esbuild 已把服务端（含依赖）打包为单文件，无需再带 node_modules
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist-server/index.cjs"]
