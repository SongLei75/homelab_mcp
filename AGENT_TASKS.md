# 智能体工作内容：mcp-local-gateway P0

## 目标

创建一个最小可验证 MCP Server，只暴露一个 `run_date` 工具，通过 HTTP `/mcp` endpoint 被本地 curl、MCP Inspector、ChatGPT Connector 后续调用。

P0 不做完整 Bash，不接 OpenAI API，不做 UI widget，不实现完整 OAuth。

## 执行步骤

```bash
mkdir -p ~/project
cd ~/project
unzip /path/to/mcp-local-gateway.zip
cd mcp-local-gateway
npm install
cp .env.example .env
npm run dev
```

另开终端验证：

```bash
cd ~/project/mcp-local-gateway
npm run typecheck
npm run build
npm test
npm run test:local
```

## 验收标准

1. `npm run typecheck` 通过。
2. `npm run build` 通过。
3. `npm test` 通过。
4. `curl http://127.0.0.1:8787/healthz` 返回 `status: ok`。
5. `/mcp initialize` 返回成功响应。
6. `/mcp tools/list` 能看到 `run_date`。
7. `/mcp tools/call run_date` 返回本机 `date` 输出。
8. `logs/audit.jsonl` 中能看到 `tool.policy` 和 `tool.exec` 记录。
9. 服务只监听 `127.0.0.1`。
10. 代码中没有任意 `run_command(command: string)` 工具。

## Git 展示命令

```bash
cd ~/project/mcp-local-gateway

echo "== git status =="
git status --short

echo
echo "== file tree =="
find . -maxdepth 3 -type f \
  | sort \
  | sed 's#^./##' \
  | grep -Ev 'node_modules|dist|package-lock.json|logs'

echo
echo "== diff stat =="
git diff --stat

echo
echo "== full diff =="
git diff -- . ':!package-lock.json'
```

## 首次提交建议

```bash
cd ~/project/mcp-local-gateway
git init
git add package.json package-lock.json tsconfig.json .env.example .gitignore README.md AGENT_TASKS.md src scripts test
git commit -m "feat: add minimal MCP local gateway"
```

## P1 工作

1. Cloudflare Tunnel：`https://mcp.songlei.me/mcp -> http://127.0.0.1:8787/mcp`。
2. 开启 `MCP_AUTH_MODE=static_bearer` 做短期私有验证。
3. 在 ChatGPT Settings -> Apps & Connectors -> Create 中填写公开 `/mcp` endpoint。
4. 刷新 connector metadata，确认工具列表只显示 `run_date`。
5. 再进入 OAuth / OIDC 正式认证。
