---
title: Qwen3.5 2B API
emoji: ⚡
colorFrom: blue
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
---

# Qwen3.5-2B OpenAI-compatible endpoint (llama.cpp)

Serves [Qwen/Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) (Apache-2.0) as a GGUF build
(`unsloth/Qwen3.5-2B-GGUF`, Q4_K_M ≈ 1.3 GB) with the official llama.cpp server image.

## Deploy
1. On Hugging Face: **New Space → SDK: Docker → Blank**, hardware *CPU basic* (free) or a GPU.
2. Upload `Dockerfile` and this `README.md` (the YAML header above configures the Space).
3. *Settings → Variables and secrets → New secret*: `LLAMA_API_KEY` = a long random string.
4. Wait for the build; the first start downloads the model.
5. In Vercel set:
   - `LLM_BASE_URL` = `https://<user>-<space-name>.hf.space/v1`
   - `LLM_API_KEY`  = the same secret
   - `LLM_MODEL`    = `qwen3.5-2b` (llama.cpp accepts any name)

Test: `curl https://<user>-<space-name>.hf.space/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Say ready"}],"max_tokens":10}'`

Free CPU Spaces sleep when idle; the first request after a pause can take a minute. On a slow CPU, a long
answer can exceed Vercel's 60 s function limit: lower `LLM_MAX_TOKENS` (e.g. 250) or use GPU hardware.
