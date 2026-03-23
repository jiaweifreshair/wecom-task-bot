#!/bin/bash

set -euo pipefail

# Define colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"
FRONTEND_DIR="${SCRIPT_DIR}/frontend"
SKIP_SYSTEM_PACKAGES=0
SKIP_NPM_INSTALL=0

# show_usage
# 是什么：脚本帮助输出函数。
# 做什么：展示当前初始化脚本支持的参数与典型用法。
# 为什么：部署环境差异较大，先给出稳定入口可以减少误用成本。
show_usage() {
    cat <<'EOF'
用法: bash init-linux.sh [--skip-system-packages] [--skip-npm-install] [--help]

选项:
  --skip-system-packages  跳过 Linux 系统依赖安装，仅做环境校验与 npm 处理
  --skip-npm-install      跳过前后端 npm install，仅做系统依赖与 sqlite3 校验
  --help                  查看帮助

典型用法:
  bash init-linux.sh
  bash init-linux.sh --skip-system-packages
EOF
}

# parse_args
# 是什么：命令行参数解析函数。
# 做什么：识别跳过开关与帮助参数，并写入脚本级状态变量。
# 为什么：初始化流程有时需要复用到受限环境，允许按需跳过某些步骤更稳妥。
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --skip-system-packages)
                SKIP_SYSTEM_PACKAGES=1
                ;;
            --skip-npm-install)
                SKIP_NPM_INSTALL=1
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                echo -e "${RED}Error: unsupported argument '$1'.${NC}"
                show_usage
                exit 1
                ;;
        esac
        shift
    done
}

# log_step
# 是什么：普通步骤日志函数。
# 做什么：以统一格式输出当前执行阶段。
# 为什么：初始化步骤较多，统一日志样式更便于定位中断点。
log_step() {
    echo -e "${GREEN}--> $1${NC}"
}

# log_warn
# 是什么：告警日志函数。
# 做什么：输出需要用户注意但尚未中断流程的信息。
# 为什么：例如缺少 `.env` 时应提醒，但不必阻塞环境初始化。
log_warn() {
    echo -e "${YELLOW}$1${NC}"
}

# log_error
# 是什么：错误日志函数。
# 做什么：输出需要立即停止处理的错误信息。
# 为什么：关键前置条件不满足时继续执行只会产生更多噪音日志。
log_error() {
    echo -e "${RED}$1${NC}"
}

# require_linux
# 是什么：运行平台限制函数。
# 做什么：仅允许脚本在 Linux 系统执行。
# 为什么：当前脚本面向服务器初始化，macOS 与 Windows 的包管理流程完全不同。
require_linux() {
    if [ "$(uname -s)" != "Linux" ]; then
        log_error "Error: init-linux.sh only supports Linux hosts."
        exit 1
    fi
}

# detect_linux_package_manager
# 是什么：Linux 包管理器探测函数。
# 做什么：按常见发行版顺序识别 dnf、yum 或 apt-get。
# 为什么：系统依赖安装命令与包名依赖发行版差异，必须先识别环境。
detect_linux_package_manager() {
    if command -v dnf >/dev/null 2>&1; then
        echo "dnf"
        return
    fi

    if command -v yum >/dev/null 2>&1; then
        echo "yum"
        return
    fi

    if command -v apt-get >/dev/null 2>&1; then
        echo "apt-get"
        return
    fi

    echo ""
}

# resolve_privilege_prefix
# 是什么：提权前缀解析函数。
# 做什么：判断当前是否已是 root，否则尝试返回 sudo 前缀。
# 为什么：系统依赖安装通常需要管理员权限，但不同机器的执行身份不一致。
resolve_privilege_prefix() {
    if [ "$(id -u)" -eq 0 ]; then
        echo ""
        return
    fi

    if command -v sudo >/dev/null 2>&1; then
        echo "sudo"
        return
    fi

    echo ""
}

# run_with_privilege
# 是什么：带可选提权的命令执行函数。
# 做什么：在需要时自动拼接 sudo 执行系统安装命令。
# 为什么：避免在多个安装分支中重复写提权判断逻辑。
run_with_privilege() {
    local privilege_prefix="$1"
    shift

    if [ -n "${privilege_prefix}" ]; then
        "${privilege_prefix}" "$@"
        return
    fi

    "$@"
}

# ensure_node_runtime
# 是什么：Node.js 运行时校验函数。
# 做什么：校验 node 与 npm 是否存在，且 Node 主版本至少为 18。
# 为什么：当前项目前后端构建与测试都依赖较新的 Node 运行时，版本过低会导致安装和构建异常。
ensure_node_runtime() {
    if ! command -v node >/dev/null 2>&1; then
        log_error "Error: node is not installed. Please install Node.js 18+ first."
        exit 1
    fi

    if ! command -v npm >/dev/null 2>&1; then
        log_error "Error: npm is not installed. Please install npm together with Node.js 18+ first."
        exit 1
    fi

    local node_major=""
    node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
    if [ "${node_major}" -lt 18 ]; then
        log_error "Error: Node.js 18+ is required, current version is $(node -v)."
        exit 1
    fi

    log_step "Detected Node.js $(node -v) / npm $(npm -v)"
}

# collect_missing_toolchain
# 是什么：原生编译工具缺失项收集函数。
# 做什么：检测 `gcc/g++/make/python3` 是否齐全，并返回缺失列表。
# 为什么：`sqlite3` 在 Linux 上可能回退到 node-gyp 编译，缺任何一个工具都会安装失败。
collect_missing_toolchain() {
    local missing_tools=()

    if ! command -v gcc >/dev/null 2>&1; then
        missing_tools+=("gcc")
    fi

    if ! command -v g++ >/dev/null 2>&1; then
        missing_tools+=("g++")
    fi

    if ! command -v make >/dev/null 2>&1; then
        missing_tools+=("make")
    fi

    if ! command -v python3 >/dev/null 2>&1; then
        missing_tools+=("python3")
    fi

    echo "${missing_tools[*]:-}"
}

# install_system_packages
# 是什么：Linux 系统依赖安装函数。
# 做什么：按发行版安装 sqlite3 原生编译所需工具链。
# 为什么：这是当前项目在 Linux 上最常见的阻塞点，需要在初始化阶段一次性解决。
install_system_packages() {
    local package_manager=""
    local privilege_prefix=""

    package_manager="$(detect_linux_package_manager)"
    if [ -z "${package_manager}" ]; then
        log_error "Error: unsupported Linux package manager. Please install gcc g++ make python3 manually."
        exit 1
    fi

    privilege_prefix="$(resolve_privilege_prefix)"
    if [ -z "${privilege_prefix}" ] && [ "$(id -u)" -ne 0 ]; then
        log_error "Error: system package installation requires root or sudo privileges."
        exit 1
    fi

    log_step "Installing Linux native build toolchain via ${package_manager}"
    case "${package_manager}" in
        dnf)
            run_with_privilege "${privilege_prefix}" dnf install -y gcc gcc-c++ make python3
            ;;
        yum)
            run_with_privilege "${privilege_prefix}" yum install -y gcc gcc-c++ make python3
            ;;
        apt-get)
            run_with_privilege "${privilege_prefix}" apt-get update
            run_with_privilege "${privilege_prefix}" apt-get install -y build-essential python3 make g++
            ;;
    esac
}

# ensure_native_toolchain
# 是什么：原生编译工具链校验与补齐函数。
# 做什么：检查缺失项，必要时自动安装，并在安装后再次校验结果。
# 为什么：相比直接进入 npm 安装，这一步能把失败原因前置成更清晰的系统依赖问题。
ensure_native_toolchain() {
    local missing_tools=""
    missing_tools="$(collect_missing_toolchain)"

    if [ -z "${missing_tools}" ]; then
        log_step "Native build toolchain is ready"
        return
    fi

    log_warn "Detected missing native build tools: ${missing_tools}"
    if [ "${SKIP_SYSTEM_PACKAGES}" -eq 1 ]; then
        log_error "Error: system packages are missing but --skip-system-packages was specified."
        exit 1
    fi

    install_system_packages

    missing_tools="$(collect_missing_toolchain)"
    if [ -n "${missing_tools}" ]; then
        log_error "Error: native build tools are still missing after installation: ${missing_tools}"
        exit 1
    fi

    log_step "Native build toolchain installed successfully"
}

# warn_missing_env_file
# 是什么：环境文件缺失提示函数。
# 做什么：检测 `backend/.env` 是否存在并输出提醒。
# 为什么：初始化脚本只负责机器环境，不应隐式生成业务配置，但需要提前提醒用户补齐。
warn_missing_env_file() {
    if [ -f "${BACKEND_DIR}/.env" ]; then
        log_step "Detected backend/.env"
        return
    fi

    log_warn "Warning: backend/.env is missing. Please create and fill it before running start.sh."
}

# install_project_dependencies
# 是什么：项目依赖安装函数。
# 做什么：分别执行前后端 `npm install --include=optional`，确保 lockfile 依赖与可选原生依赖完整。
# 为什么：前端构建依赖 optional 包，后端 sqlite3 也依赖 optional/原生包，统一安装最稳妥。
install_project_dependencies() {
    if [ "${SKIP_NPM_INSTALL}" -eq 1 ]; then
        log_warn "Skip npm install because --skip-npm-install was specified"
        return
    fi

    if [ ! -f "${FRONTEND_DIR}/package.json" ]; then
        log_error "Error: frontend/package.json not found."
        exit 1
    fi

    if [ ! -f "${BACKEND_DIR}/package.json" ]; then
        log_error "Error: backend/package.json not found."
        exit 1
    fi

    log_step "Installing frontend dependencies"
    (
        cd "${FRONTEND_DIR}"
        npm install --include=optional
    )

    log_step "Installing backend dependencies"
    (
        cd "${BACKEND_DIR}"
        npm install --include=optional
    )
}

# verify_sqlite3_runtime
# 是什么：sqlite3 原生模块预热函数。
# 做什么：检测后端是否能直接 `require('sqlite3')`，失败时自动重建并再次校验。
# 为什么：把 Linux 上最常见的运行时风险提前暴露并修复，避免等到 start.sh 阶段才中断。
resolve_backend_db_client() {
    local env_file="${BACKEND_DIR}/.env"
    local explicit_client="${TASK_BOT_DB_CLIENT:-${WECOM_TASK_BOT_DB_CLIENT:-}}"
    local configured_path="${TASK_BOT_DB_PATH:-${WECOM_TASK_BOT_DB_PATH:-}}"

    if [ -z "${explicit_client}" ] && [ -f "${env_file}" ]; then
        explicit_client="$(grep -E '^(TASK_BOT_DB_CLIENT|WECOM_TASK_BOT_DB_CLIENT)=' "${env_file}" | tail -n 1 | cut -d'=' -f2-)"
    fi

    explicit_client="${explicit_client//\"/}"
    explicit_client="${explicit_client//\'/}"
    explicit_client="${explicit_client,,}"
    explicit_client="${explicit_client#"${explicit_client%%[![:space:]]*}"}"
    explicit_client="${explicit_client%"${explicit_client##*[![:space:]]}"}"

    if [ -z "${configured_path}" ] && [ -z "${explicit_client}" ] && [ -f "${env_file}" ]; then
        configured_path="$(grep -E '^(TASK_BOT_DB_PATH|WECOM_TASK_BOT_DB_PATH)=' "${env_file}" | tail -n 1 | cut -d'=' -f2-)"
    fi

    configured_path="${configured_path//\"/}"
    configured_path="${configured_path//\'/}"
    configured_path="${configured_path#"${configured_path%%[![:space:]]*}"}"
    configured_path="${configured_path%"${configured_path##*[![:space:]]}"}"

    if [ "${explicit_client}" = "sqlite" ] || [ -n "${configured_path}" ]; then
        echo "sqlite"
        return
    fi

    echo "mysql"
}

verify_sqlite3_runtime() {
    local db_client
    db_client="$(resolve_backend_db_client)"

    if [ "${db_client}" != "sqlite" ]; then
        log_step "Detected ${db_client} backend database client, skip sqlite3 native verification"
        return
    fi

    log_step "Verifying backend sqlite3 native module"

    (
        cd "${BACKEND_DIR}"

        if node -e "require('sqlite3')" >/dev/null 2>&1; then
            log_step "sqlite3 native module is ready"
            return
        fi

        log_warn "sqlite3 native module is not loadable, attempting npm rebuild sqlite3"
        if ! npm rebuild sqlite3; then
            log_warn "npm rebuild sqlite3 failed, retrying backend npm install"
            npm install --include=optional
        fi

        if ! node -e "require('sqlite3')" >/dev/null 2>&1; then
            log_error "Error: sqlite3 is still not loadable after rebuild."
            exit 1
        fi
    )

    log_step "sqlite3 native module verification passed"
}

# print_next_steps
# 是什么：收尾提示函数。
# 做什么：输出当前初始化完成后的下一步操作建议。
# 为什么：初始化成功后用户通常需要继续配置环境并启动服务，直接给路径最省心。
print_next_steps() {
    echo -e "${GREEN}==========================================${NC}"
    echo -e "${GREEN} Linux environment initialization completed ${NC}"
    echo -e "${GREEN}==========================================${NC}"
    echo "Next steps:"
    echo "1. Edit backend/.env and fill your WeCom configuration."
    echo "2. Run: bash start.sh"
}

parse_args "$@"
require_linux
ensure_node_runtime
ensure_native_toolchain
warn_missing_env_file
install_project_dependencies
verify_sqlite3_runtime
print_next_steps
