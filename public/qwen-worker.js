// Web Worker: runs Qwen3.5 (2B or 0.8B, ONNX) in the browser with Transformers.js.
// device "webgpu" uses the GPU; device "wasm" runs on the CPU (slow, but needs no GPU).
// Nothing is sent to a server: the model files are downloaded once from the Hugging Face Hub
// and cached by the browser. Loaded as a module worker from /qwen-worker.js.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

let tf = null;
let processor = null;
let model = null;
let loadedKey = null;
let loading = null;

function post(msg) {
  self.postMessage(msg);
}

function progress(p) {
  if (!p) return;
  if (p.status === "progress" && p.total) {
    post({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
  } else if (p.status === "ready" || p.status === "done") {
    post({ type: "progress", file: p.file, done: true });
  }
}

/** Ask for a GPU adapter in this worker - the same context ONNX Runtime will use. */
async function probeGpu() {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    return { ok: false, reason: "no-webgpu" };
  }
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (_) {
    adapter = null;
  }
  if (!adapter) return { ok: false, reason: "no-adapter" };
  const info = adapter.info || {};
  return {
    ok: true,
    vendor: info.vendor || "",
    architecture: info.architecture || "",
    description: info.description || "",
    isFallback: !!(info.isFallbackAdapter || adapter.isFallbackAdapter),
    shaderF16: adapter.features ? adapter.features.has("shader-f16") : false,
    maxBufferMB: adapter.limits ? Math.round(adapter.limits.maxBufferSize / 1048576) : null,
  };
}

async function load(modelId, device) {
  const key = `${modelId}|${device}`;
  if (model && loadedKey === key) {
    post({ type: "ready", modelId, device });
    return;
  }
  if (loading) return loading;
  loading = (async () => {
    if (device === "webgpu") {
      // Check before downloading ~1-2 GB: Chrome can refuse a GPU adapter, e.g. after the GPU was
      // reset twice on this site (it then blocks WebGPU for the site until Chrome restarts).
      const gpu = await probeGpu();
      post({ type: "gpu", info: gpu });
      if (!gpu.ok) {
        const err = new Error(gpu.reason === "no-webgpu" ? "WebGPU is not available in this browser" : "Failed to get GPU adapter");
        err.code = gpu.reason;
        throw err;
      }
    }
    model = null;
    loadedKey = null;
    post({ type: "status", text: "Loading Transformers.js…" });
    tf = tf || (await import(TRANSFORMERS_URL));
    const { AutoProcessor, Qwen3_5ForConditionalGeneration } = tf;
    post({ type: "status", text: `Downloading ${modelId.split("/").pop()} (first time only)…` });
    processor = await AutoProcessor.from_pretrained(modelId, { progress_callback: progress });
    // The vision encoder is never used here (text only), so its smallest variant is tried first.
    const layouts =
      device === "webgpu"
        ? [
            { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" },
            { embed_tokens: "q4", vision_encoder: "fp16", decoder_model_merged: "q4" },
            { embed_tokens: "q4f16", vision_encoder: "fp16", decoder_model_merged: "q4f16" },
            "q4f16",
            "q4",
          ]
        : [{ embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" }, "q4", "q8"];
    post({ type: "status", text: device === "webgpu" ? "Preparing the model on your GPU…" : "Preparing the model on your CPU…" });
    let lastErr = null;
    for (const dtype of layouts) {
      try {
        model = await Qwen3_5ForConditionalGeneration.from_pretrained(modelId, { dtype, device, progress_callback: progress });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        // no point trying other file layouts if the GPU itself is unavailable
        if (/adapter|no available backend|device (was )?lost/i.test(String((e && e.message) || e))) break;
      }
    }
    if (lastErr) throw lastErr;
    loadedKey = key;
    post({ type: "ready", modelId, device });
  })();
  try {
    await loading;
  } catch (e) {
    model = null;
    loadedKey = null;
    const message = String((e && e.message) || e);
    const code = e && e.code ? e.code : /Failed to get GPU adapter|no available backend/i.test(message) ? "no-adapter" : "load-failed";
    post({ type: "error", stage: "load", code, message });
  } finally {
    loading = null;
  }
}

async function generate(id, messages, maxNewTokens) {
  if (!model || !processor) {
    post({ type: "error", id, stage: "generate", message: "Model not loaded" });
    return;
  }
  try {
    const { TextStreamer } = tf;
    const conversation = messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
    const text = processor.apply_chat_template(conversation, { add_generation_prompt: true, enable_thinking: false });
    const inputs = await processor(text);
    let streamed = "";
    const streamer = new TextStreamer(processor.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (t) => {
        streamed += t;
        post({ type: "token", id, text: t });
      },
    });
    const output = await model.generate({ ...inputs, max_new_tokens: maxNewTokens || 300, do_sample: false, repetition_penalty: 1.05, streamer });
    let final = streamed;
    try {
      const promptLen = inputs.input_ids.dims.at(-1);
      const decoded = processor.batch_decode(output.slice(null, [promptLen, null]), { skip_special_tokens: true });
      if (decoded && decoded[0]) final = decoded[0];
    } catch (_) {
      /* fall back to the streamed text */
    }
    final = final.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    post({ type: "done", id, text: final });
  } catch (e) {
    const message = String((e && e.message) || e);
    // "Device was lost" = the browser reset the GPU (out of memory or driver timeout).
    // The ONNX sessions are dead after that, so drop them; the page will offer a reload.
    const deviceLost = /device (was )?lost|mapAsync|OrtRun|GPUBuffer|out of memory/i.test(message);
    if (deviceLost) {
      model = null;
      processor = null;
      loadedKey = null;
    }
    post({ type: "error", id, stage: "generate", deviceLost, message });
  }
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === "probe") post({ type: "gpu", info: await probeGpu() });
  if (msg.type === "load") load(msg.modelId, msg.device === "wasm" ? "wasm" : "webgpu");
  if (msg.type === "generate") generate(msg.id, msg.messages, msg.maxNewTokens);
};
