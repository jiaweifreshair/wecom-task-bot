# 本地 Docker 部署说明

## 是什么

这是一套面向本地联调的 Docker 部署方案，包含：

- `mysql` 容器：负责业务库持久化
- `app` 容器：负责构建前端并启动后端一体化服务

## 做什么

使用根目录的 `Dockerfile` 和 `docker-compose.yml`，在本地直接启动：

- MySQL 8.4
- Node 20 运行时
- 前端打包产物
- 后端 Express 服务
- MySQL 自动建库建表

## 为什么

项目当前没有现成 Docker 资产；补齐后可以在本地用一致环境验证发布链路，减少“本机可运行、部署后失败”的偏差。

## 端口约定

- Web 应用：`http://localhost:8080`
- MySQL 宿主机映射：`127.0.0.1:3307`

## 依赖前提

宿主机需要先安装并启动 Docker Desktop 或等效 Docker Engine，使以下命令可用：

```bash
docker --version
docker compose version
```

## 启动步骤

在项目根目录执行：

```bash
docker compose up --build -d
```

首次启动时，应用容器会自动连接 MySQL，并通过后端现有初始化逻辑完成建库建表。

## 查看状态

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f mysql
```

如果应用启动成功，日志里应出现后端启动和数据库连接成功信息。

## 停止与清理

停止服务：

```bash
docker compose down
```

连同 MySQL 数据卷一起清理：

```bash
docker compose down -v
```

## 配置说明

`app` 服务默认会加载 `backend/.env`，并在 Compose 中覆盖以下部署相关变量：

- `PORT=8080`
- `APP_URL=http://localhost:8080`
- `FRONTEND_URL=http://localhost:8080`
- `AUTH_CALLBACK_BASE_URL=http://localhost:8080`
- `TASK_BOT_DB_CLIENT=mysql`
- `TASK_BOT_DB_HOST=mysql`
- `TASK_BOT_DB_PORT=3306`
- `TASK_BOT_DB_NAME=wecom_task_bot`
- `TASK_BOT_DB_USER=wecom_task_bot`
- `TASK_BOT_DB_PASSWORD=wecom_task_bot`

## 当前机器的阻塞

当前这台机器没有安装可用的 Docker 命令，因此我无法在本地实际执行 `docker compose up --build` 做容器级验证。等宿主机安装并启动 Docker 后，按上面的步骤即可直接验证。
