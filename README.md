# PYNQ Jupyter MCP bridge

This is a local Streamable HTTP MCP server. It talks to the Jupyter Server API on the USB-connected PYNQ-ZU board and exposes `list_notebooks`, `read_notebook`, and `execute_cell` to Codex.

## Setup

1. Copy `.env.example` to `.env` and set **one** credential:
   - `JUPYTER_TOKEN`: the `token=...` value in the Jupyter URL or `jupyter server list` output; or
   - `JUPYTER_PASSWORD`: the password used to sign into the Jupyter Lab web page. This is for servers whose `jupyter server list` output has no token.
2. Install dependencies with `npm install`.
3. In PowerShell, run the service:

   ```powershell
   .\start-bridge.ps1
   ```

4. Confirm `http://127.0.0.1:8787/health` returns `ok: true`.
5. In Codex Desktop: **Settings → MCP servers → Add server → Streamable HTTP**. Use `http://127.0.0.1:8787/mcp`, save, then restart Codex.

`execute_cell` runs arbitrary Python on the board. Keep this service bound to `127.0.0.1`, do not expose it to your LAN, and leave its Codex approval setting at prompt/writes.
