重新啟動 bridge:
cd C:\Users\user\Documents\Codex\pynq-mcpbridge
.\start-bridge.ps1
應輸出:
> pynq-jupyter-mcp-bridge@0.1.0 start
> node src/server.js
PYNQ Jupyter MCP bridge: http://127.0.0.1:8787/mcp

開另一個命令提示字元視窗，進行powershell測試：
curl.exe http://127.0.0.1:8787/health
應輸出: {"ok":true,"jupyter":"2.12.5"}