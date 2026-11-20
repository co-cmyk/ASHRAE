// Web Worker: runs Qwen3.5 (2B or 0.8B, ONNX) in the browser with Transformers.js + WebGPU.
// Nothing is sent to a server: the model files are downloaded once from the Hugging Face Hub
// and cached by the browser. Loaded as a module worker from /qwen-worker.js.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

let tf = null;
let processor = null;
let model = null;
let loadedId = null;
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

async function load(modelId) {
  if (model && loadedId === modelId) {
    post({ type: "ready", modelId });
    return;
  }
  if (loading) return loading;
  loading = (async () => {
    post({ type: "status", text: "Loading Transformers.js…" });
    tf = tf || (await import(TRANSFORMERS_URL));
    const { AutoProcessor, Qwen3_5ForConditionalGeneration } = tf;
    post({ type: "status", text: `Downloading ${modelId} (first time only)…` });
    processor = await AutoProcessor.from_pretrained(modelId, { progress_callback: progress });
    // Try the dtype layouts published for Qwen3.5 ONNX exports, most compact first.
    // The vision encoder is never used here (text only), so try its smallest variant first to save GPU memory.
    const layouts = [
      { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" },
      { embed_tokens: "q4", vision_encoder: "fp16", decoder_model_merged: "q4" },
      { embed_tokens: "q4f16", vision_encoder: "fp16", decoder_model_merged: "q4f16" },
      "q4f16",
      "q4",
    ];
    let lastErr = null;
    for (const dtype of layouts) {
      try {
        model = await Qwen3_5ForConditionalGeneration.from_pretrained(modelId, { dtype, device: "webgpu", progress_callback: progress });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    loadedId = modelId;
    post({ type: "ready", modelId });
  })();
  try {
    await loading;
  } catch (e) {
    model = null;
    loadedId = null;
    post({ type: "error", stage: "load", message: String((e && e.message) || e) });
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
      loadedId = null;
    }
    post({ type: "error", id, stage: "generate", deviceLost, message });
  }
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "load") load(msg.modelId);
  if (msg.type === "generate") generate(msg.id, msg.messages, msg.maxNewTokens);
};
