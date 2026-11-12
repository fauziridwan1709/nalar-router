#!/usr/bin/env bash
# Expose the local MLX server (port 8080) to the deployed gateway through an ngrok tunnel.
# Requests without "Authorization: Bearer $LOCAL_LLM_API_KEY" get a 401 at ngrok's edge,
# so the tunnel can't be used as a free public LLM endpoint.
#
#   LOCAL_LLM_API_KEY=$(openssl rand -hex 24) NGROK_DOMAIN=<your-static-domain>.ngrok-free.app \
#     tools/tunnel/local-qwen.sh
#
# Then on Render set LOCAL_LLM_ENABLED=true, LOCAL_LLM_BASE_URL=https://$NGROK_DOMAIN/v1 and the
# same LOCAL_LLM_API_KEY. See README "Local model on the deployed URL".
set -euo pipefail

: "${LOCAL_LLM_API_KEY:?set LOCAL_LLM_API_KEY to a long random secret (e.g. openssl rand -hex 24)}"
: "${NGROK_DOMAIN:?set NGROK_DOMAIN to your free static ngrok domain (dashboard.ngrok.com/domains)}"
PORT="${LOCAL_LLM_PORT:-8080}"

curl -sf "http://127.0.0.1:${PORT}/v1/models" > /dev/null \
  || { echo "nothing answers on :${PORT}; start mlx_lm.server first" >&2; exit 1; }

policy="$(mktemp -t ngrok-policy).yml"
trap 'rm -f "$policy"' EXIT
cat > "$policy" <<YAML
on_http_request:
  - expressions:
      - "!('authorization' in req.headers) || req.headers['authorization'][0] != 'Bearer ${LOCAL_LLM_API_KEY}'"
    actions:
      - type: custom-response
        config:
          status_code: 401
          content: unauthorized
YAML

exec ngrok http "$PORT" --url "https://${NGROK_DOMAIN}" --traffic-policy-file "$policy"
