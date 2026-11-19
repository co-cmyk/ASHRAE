# Always-on Qwen3.5-2B endpoint (OpenAI-compatible) for the assistant's "server" mode.
# Deploy as a Hugging Face Space (SDK: Docker). Free CPU hardware works for a demo (expect
# roughly 5–15 tokens/s); GPU hardware is much faster.
FROM ghcr.io/ggml-org/llama.cpp:server

# Writable model cache (Spaces run as a non-root user)
ENV LLAMA_CACHE=/tmp/llama-cache
ENV MODEL_REPO=unsloth/Qwen3.5-2B-GGUF:Q4_K_M
ENV CTX_SIZE=8192
EXPOSE 7860

# LLAMA_API_KEY comes from the Space's Secrets; requests must send "Authorization: Bearer <key>".
ENTRYPOINT ["/bin/sh", "-c", "exec /app/llama-server -hf \"$MODEL_REPO\" --host 0.0.0.0 --port 7860 --ctx-size \"$CTX_SIZE\" --jinja -np 1 ${LLAMA_API_KEY:+--api-key \"$LLAMA_API_KEY\"}"]
