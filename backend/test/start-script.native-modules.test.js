const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

// repoRoot / startScriptPath / startScriptPrelude
// 是什么：`start.sh` 单元测试所需的仓库根目录、脚本路径与函数前置内容。
// 做什么：读取启动脚本中“函数定义但尚未执行主流程”的部分，供测试按需 source 后调用指定函数。
// 为什么：直接 source 整个 `start.sh` 会触发真实启动流程，无法稳定验证 sqlite3 自愈分支。
const repoRoot = path.resolve(__dirname, '../..');
const startScriptPath = path.resolve(repoRoot, 'start.sh');
const startScriptPrelude = fs
  .readFileSync(startScriptPath, 'utf8')
  .split('echo -e "${GREEN}Starting WeCom Task Bot...${NC}"')[0];

// runStartScriptPrelude
// 是什么：`start.sh` 函数前置内容执行辅助函数。
// 做什么：把预处理后的脚本写入临时文件，再在独立 bash 进程里 source 并执行测试片段。
// 为什么：这样可以精确 stub `node/npm/uname` 等命令，复现 Linux 缺编译链时的恢复路径。
const runStartScriptPrelude = (scriptBody) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-script-test-'));
  const preludePath = path.join(tempDir, 'start-prelude.sh');
  fs.writeFileSync(preludePath, startScriptPrelude, 'utf8');

  const result = spawnSync(
    'bash',
    [
      '-lc',
      `
        set -euo pipefail
        source "${preludePath}"
        SCRIPT_DIR="${repoRoot}"
        BACKEND_DIR="${repoRoot}/backend"
        FRONTEND_DIR="${repoRoot}/frontend"
        ${scriptBody}
      `,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
  return result;
};

test('verify_backend_native_modules 在 Linux 缺少编译链时应先尝试 sqlite3 自愈', () => {
  const result = runStartScriptPrelude(`
    PATH="/tmp"
    SQLITE3_REQUIRE_ATTEMPTS=0

    uname() {
      echo "Linux"
    }

    node() {
      if [ "$1" = "-e" ] && [ "$2" = "require('sqlite3')" ]; then
        SQLITE3_REQUIRE_ATTEMPTS=$((SQLITE3_REQUIRE_ATTEMPTS + 1))
        if [ "\${SQLITE3_REQUIRE_ATTEMPTS}" -eq 1 ]; then
          return 1
        fi
      fi
      return 0
    }

    npm() {
      if [ "$1" = "rebuild" ] && [ "$2" = "sqlite3" ]; then
        return 0
      fi

      echo "unexpected npm invocation: $*" >&2
      return 2
    }

    verify_backend_native_modules
    printf 'SQLITE3_REQUIRE_ATTEMPTS=%s\\n' "\${SQLITE3_REQUIRE_ATTEMPTS}"
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Detected invalid sqlite3 native module, attempting rebuild/);
  assert.match(result.stdout, /sqlite3 rebuilt successfully/);
  assert.match(result.stdout, /SQLITE3_REQUIRE_ATTEMPTS=2/);
  assert.doesNotMatch(result.stdout, /Detected missing native build tools/);
});

test('verify_backend_native_modules 在 mysql 模式下不应再检查 sqlite3', () => {
  const result = runStartScriptPrelude(`
    export TASK_BOT_DB_CLIENT="mysql"
    export TASK_BOT_DB_PATH=""
    export WECOM_TASK_BOT_DB_PATH=""

    uname() {
      echo "Linux"
    }

    node() {
      echo "unexpected node invocation: $*" >&2
      return 2
    }

    npm() {
      echo "unexpected npm invocation: $*" >&2
      return 2
    }

    verify_backend_native_modules
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip sqlite3 runtime verification/i);
});

test('verify_backend_native_modules 在自愈失败且缺少编译链时应提示补齐工具', () => {
  const result = runStartScriptPrelude(`
    PATH="/tmp"

    uname() {
      echo "Linux"
    }

    node() {
      if [ "$1" = "-e" ] && [ "$2" = "require('sqlite3')" ]; then
        return 1
      fi
      return 0
    }

    npm() {
      return 1
    }

    rm() {
      return 0
    }

    verify_backend_native_modules
  `);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(combinedOutput, /Detected missing native build tools for sqlite3/);
  assert.match(combinedOutput, /Suggested packages|Suggested command/);
  assert.match(combinedOutput, /backend npm install failed during native module recovery/);
});
