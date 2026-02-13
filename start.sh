#!/bin/bash

# Define colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"
FRONTEND_DIR="${SCRIPT_DIR}/frontend"
BACKEND_PID=""
START_MODE="${1:-integrated}"
BACKEND_PORT="80"
APP_URL_DISPLAY=""

# validate_start_mode
# 是什么：启动模式参数校验函数。
# 做什么：仅允许 integrated 单端口模式，拒绝其他模式参数。
# 为什么：当前部署目标是后端托管前端静态资源，避免前后端双端口运行带来的复杂性。
validate_start_mode() {
    if [ "${START_MODE}" != "integrated" ]; then
        echo -e "${RED}Error: unsupported mode '${START_MODE}'.${NC}"
        echo -e "${YELLOW}Only integrated mode is supported now (single port).${NC}"
        echo "Usage: bash start.sh [integrated]"
        exit 1
    fi
}

# resolve_backend_runtime_info
# 是什么：后端运行信息解析函数。
# 做什么：从 backend/.env 解析 PORT 与 APP_URL，并生成启动展示地址。
# 为什么：避免启动成功信息写死，确保运维可直接看到真实访问地址与端口。
resolve_backend_runtime_info() {
    local port_line=""
    local app_url_line=""

    if [ -f "${BACKEND_DIR}/.env" ]; then
        port_line=$(grep -E '^[[:space:]]*PORT=' "${BACKEND_DIR}/.env" | tail -n 1 || true)
        app_url_line=$(grep -E '^[[:space:]]*APP_URL=' "${BACKEND_DIR}/.env" | tail -n 1 || true)

        if [ -n "${port_line}" ]; then
            BACKEND_PORT="${port_line#*=}"
            BACKEND_PORT="${BACKEND_PORT//\"/}"
            BACKEND_PORT="${BACKEND_PORT//\'/}"
            BACKEND_PORT="$(echo "${BACKEND_PORT}" | tr -d '[:space:]')"
        fi

        if [ -n "${app_url_line}" ]; then
            APP_URL_DISPLAY="${app_url_line#*=}"
            APP_URL_DISPLAY="${APP_URL_DISPLAY//\"/}"
            APP_URL_DISPLAY="${APP_URL_DISPLAY//\'/}"
            APP_URL_DISPLAY="$(echo "${APP_URL_DISPLAY}" | tr -d '[:space:]')"
        fi
    fi

    if [ -z "${APP_URL_DISPLAY}" ]; then
        APP_URL_DISPLAY="http://127.0.0.1:${BACKEND_PORT}"
    fi
}

# prepare_frontend_assets
# 是什么：前端依赖安装与构建函数。
# 做什么：在缺少或损坏依赖时安装 `node_modules`（含 optional 依赖），并执行 `npm run build` 生成 `dist` 静态资源。
# 为什么：后端会直接托管 `frontend/dist`，且 Rollup 原生可选依赖缺失会导致前端构建失败。
prepare_frontend_assets() {
    if [ ! -f "${FRONTEND_DIR}/package.json" ]; then
        echo -e "${RED}Error: frontend/package.json not found, cannot build frontend.${NC}"
        exit 1
    fi

    echo -e "${GREEN}--> Preparing Frontend assets...${NC}"
    cd "${FRONTEND_DIR}" || exit 1

    if [ ! -d node_modules ]; then
        echo -e "${YELLOW}Frontend node_modules not found, running npm install...${NC}"
        if ! npm install --include=optional; then
            echo -e "${RED}Error: frontend npm install failed.${NC}"
            exit 1
        fi
    fi

    if ! node -e "require('rollup/dist/native.js')" >/dev/null 2>&1; then
        echo -e "${YELLOW}Detected missing Rollup native optional dependency, reinstalling frontend dependencies...${NC}"

        if [ -d node_modules ]; then
            rm -rf node_modules
        fi

        if ! npm install --include=optional; then
            echo -e "${RED}Error: frontend npm install failed during Rollup native dependency recovery.${NC}"
            exit 1
        fi

        if ! node -e "require('rollup/dist/native.js')" >/dev/null 2>&1; then
            echo -e "${RED}Error: Rollup native dependency is still unavailable after reinstall.${NC}"
            echo -e "${RED}Please verify npm registry connectivity and optional dependency settings.${NC}"
            exit 1
        fi
    fi

    if ! npm run build; then
        echo -e "${RED}Error: frontend build failed.${NC}"
        exit 1
    fi

    if [ ! -f "${FRONTEND_DIR}/dist/index.html" ]; then
        echo -e "${RED}Error: frontend/dist/index.html not found after build.${NC}"
        exit 1
    fi

    cd "${SCRIPT_DIR}" || exit 1
}

# ensure_backend_dependencies
# 是什么：后端依赖检查函数。
# 做什么：当 `backend/node_modules` 不存在时自动安装后端依赖。
# 为什么：避免首次部署或新环境启动时因为缺少依赖导致服务直接退出。
ensure_backend_dependencies() {
    if [ ! -f "${BACKEND_DIR}/package.json" ]; then
        echo -e "${RED}Error: backend/package.json not found, cannot start backend.${NC}"
        exit 1
    fi

    cd "${BACKEND_DIR}" || exit 1

    if [ ! -d node_modules ]; then
        echo -e "${YELLOW}Backend node_modules not found, running npm install...${NC}"
        if ! npm install --include=optional; then
            echo -e "${RED}Error: backend npm install failed.${NC}"
            exit 1
        fi
    fi

    cd "${SCRIPT_DIR}" || exit 1
}

# verify_backend_native_modules
# 是什么：后端原生依赖可加载性检查函数。
# 做什么：检测 `sqlite3` 是否能被当前 Node.js 运行时正常加载，失败时自动重装后端依赖。
# 为什么：避免将其他系统（如 macOS）构建的原生二进制带入 Linux 环境导致 `invalid ELF header`。
verify_backend_native_modules() {
    cd "${BACKEND_DIR}" || exit 1

    if ! node -e "require('sqlite3')" >/dev/null 2>&1; then
        echo -e "${YELLOW}Detected invalid sqlite3 native module, attempting rebuild...${NC}"
        
        # Try rebuild first (fixes architecture mismatch checks)
        if npm rebuild sqlite3; then
            if node -e "require('sqlite3')" >/dev/null 2>&1; then
                 echo -e "${GREEN}sqlite3 rebuilt successfully.${NC}"
                 cd "${SCRIPT_DIR}" || exit 1
                 return
            fi
        fi

        echo -e "${YELLOW}Rebuild failed, reinstalling backend dependencies...${NC}"

        if [ -d node_modules ]; then
            rm -rf node_modules
        fi

        if ! npm install --include=optional; then
            echo -e "${RED}Error: backend npm install failed during native module recovery.${NC}"
            exit 1
        fi

        if ! node -e "require('sqlite3')" >/dev/null 2>&1; then
            echo -e "${RED}Error: sqlite3 is still not loadable after reinstall.${NC}"
            echo -e "${RED}Please confirm container architecture, Node.js version, and network access for native package download.${NC}"
            exit 1
        fi
    fi

    cd "${SCRIPT_DIR}" || exit 1
}

echo -e "${GREEN}Starting WeCom Task Bot...${NC}"

validate_start_mode
resolve_backend_runtime_info

prepare_frontend_assets
ensure_backend_dependencies
verify_backend_native_modules

# 1. Start Backend (which now serves Frontend)
echo -e "${GREEN}--> Starting Server (Backend + Frontend)...${NC}"
cd "${BACKEND_DIR}" || exit 1

# Check for .env file
if [ ! -f .env ]; then
    echo -e "${YELLOW}Warning: backend/.env file not found!${NC}"
fi

# Check if port 80 is used (requires sudo)
if [ "${BACKEND_PORT}" = "80" ]; then
    echo -e "${YELLOW}Port 80 configuration detected. This requires administrator privileges.${NC}"
    echo "Please enter your password if prompted."
    if ! sudo -v; then
        echo -e "${RED}Error: sudo authentication failed, backend not started.${NC}"
        exit 1
    fi
    sudo npm start &
    BACKEND_PID=$!
else
    npm start &
    BACKEND_PID=$!
fi

sleep 2
if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo -e "${RED}Error: backend process failed to start. Please check backend logs above.${NC}"
    exit 1
fi

cd ..

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}   Server started successfully!           ${NC}"
echo -e "${GREEN}   Mode: integrated (single port)         ${NC}"
echo -e "${GREEN}   PID: $BACKEND_PID                      ${NC}"
echo -e "${GREEN}   App URL: ${APP_URL_DISPLAY}            ${NC}"
echo -e "${GREEN}==========================================${NC}"
echo "Press Ctrl+C to stop services."

# Handle shutdown
cleanup() {
    echo -e "\n${YELLOW}Stopping services...${NC}"
    
    # Kill backend (use sudo if it was started with sudo)
    if [ -n "${BACKEND_PID}" ] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
        # If we can't kill it normally (e.g. root), try sudo
        kill "${BACKEND_PID}" 2>/dev/null || sudo kill "${BACKEND_PID}"
    else
        # It might be a sudo process whose PID we have is the sudo command itself
        [ -n "${BACKEND_PID}" ] && sudo kill "${BACKEND_PID}" 2>/dev/null
    fi
    
    echo -e "${GREEN}Services stopped.${NC}"
    exit
}

trap cleanup SIGINT SIGTERM

wait
