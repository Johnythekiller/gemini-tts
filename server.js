import crypto from "node:crypto";
import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(express.json({ limit: "10mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const GEMINI_MODEL =
  process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";
const DEFAULT_VOICE_ID = process.env.GEMINI_TTS_VOICE || "Aoede";
const DEFAULT_SAMPLE_RATE = Number(process.env.DEFAULT_SAMPLE_RATE || 24000);
const VALID_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 44100]);
const GEMINI_DEFAULT_SAMPLE_RATE = 24000;

app.get("/", (req, res) => {
  res.status(200).send("Gemini 3.1 Flash TTS webhook for Vapi is running.");
});

app.get("/tts", (req, res) => {
  res.status(200).send("TTS endpoint alive. Vapi must POST here.");
});

function sanitizeHeaders(headers) {
  const redacted = { ...headers };
  for (const key of Object.keys(redacted)) {
    if (/authorization|secret|token|api[-_]?key/i.test(key)) {
      redacted[key] = "[redacted]";
    }
  }
  return redacted;
}

function parseSampleRate(value) {
  const sampleRate = Number(value);
  if (!Number.isInteger(sampleRate)) return null;
  if (!VALID_SAMPLE_RATES.has(sampleRate)) return null;
  return sampleRate;
}

function parseGeminiSampleRate(mimeType) {
  const match = String(mimeType || "").match(/rate=(\d+)/i);
  const parsed = match ? Number(match[1]) : null;
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : GEMINI_DEFAULT_SAMPLE_RATE;
}

function buildPrompt(text) {
  return `# AUDIO PROFILE
Helpful and professional personal assistant.

### DIRECTOR'S NOTES
Style: Empathetic, warm, professional, confident.
Pace: Fast and energetic, with almost no dead air.
Accent: French speech with a clear, neutral delivery.
Tone: Steady, efficient, commercially sharp, never robotic.
Voice character: Breezy, middle pitch, light vocal smile.

#### TRANSCRIPT
${text}`;
}

function pcm16LeBufferToFloat32(inputBuffer) {
  if (inputBuffer.length % 2 !== 0) {
    throw new Error(`PCM buffer length is odd: ${inputBuffer.length}`);
  }

  const samples = new Float32Array(inputBuffer.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = inputBuffer.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

function float32ToPcm16LeBuffer(samples) {
  const output = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 32768 : clamped * 32767;
    output.writeInt16LE(Math.round(value), i * 2);
  }
  return output;
}

function sinc(x) {
  if (Math.abs(x) < 1e-8) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

function hammingWindow(distance, radius) {
  const normalized = Math.abs(distance) / radius;
  if (normalized >= 1) return 0;
  return 0.54 + 0.46 * Math.cos(Math.PI * normalized);
}

function resamplePcm16Mono(inputBuffer, inputRate, outputRate) {
  if (inputRate === outputRate) return Buffer.from(inputBuffer);

  const input = pcm16LeBufferToFloat32(inputBuffer);
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);

  const ratio = inputRate / outputRate;
  const radius = 16;
  const cutoff = 0.96 * Math.min(1, outputRate / inputRate);

  for (let i = 0; i < outputLength; i++) {
    const center = i * ratio;
    const left = Math.ceil(center - radius);
    const right = Math.floor(center + radius);

    let sum = 0;
    let weightSum = 0;

    for (let j = left; j <= right; j++) {
      if (j < 0 || j >= input.length) continue;

      const distance = center - j;
      const weight =
        cutoff *
        sinc(cutoff * distance) *
        hammingWindow(distance, radius);

      sum += input[j] * weight;
      weightSum += weight;
    }

    output[i] = weightSum === 0 ? 0 : sum / weightSum;
  }

  return float32ToPcm16LeBuffer(output);
}

async function synthesizeWithGemini({ text, voiceId }) {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ parts: [{ text: buildPrompt(text) }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceId,
          },
        },
      },
    },
  });

  const audioPart = response.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.data
  );

  if (!audioPart) {
    console.error("No audio returned from Gemini:", JSON.stringify(response, null, 2));
    throw new Error("No audio returned from Gemini");
  }

  const mimeType = audioPart.inlineData?.mimeType || "";
  const sampleRate = parseGeminiSampleRate(mimeType);
  const pcm = Buffer.from(audioPart.inlineData.data, "base64");

  return { pcm, sampleRate, mimeType };
}

async function handleTTS(req, res) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const message = req.body?.message || {};
    const messageType = message.type || req.body?.type;
    const text = message.text || req.body?.text;
    const requestedSampleRate = parseSampleRate(
      message.sampleRate ?? req.body?.sampleRate ?? DEFAULT_SAMPLE_RATE
    );
    const voiceId =
      req.body?.voice?.voiceId ||
      req.body?.voiceId ||
      message.voice?.voiceId ||
      DEFAULT_VOICE_ID;

    console.log("===== VAPI TTS REQUEST =====");
    console.log("requestId:", requestId);
    console.log("headers:", JSON.stringify(sanitizeHeaders(req.headers), null, 2));
    console.log("body:", JSON.stringify(req.body, null, 2));
    console.log("message.type:", messageType);
    console.log("message.text:", text);
    console.log("message.sampleRate:", message.sampleRate);
    console.log("resolved.sampleRate:", requestedSampleRate);
    console.log("resolved.voiceId:", voiceId);

    if (messageType && messageType !== "voice-request") {
      return res.status(400).json({
        error: "Invalid message type",
        received: messageType,
      });
    }

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Missing message.text" });
    }

    if (!requestedSampleRate) {
      return res.status(400).json({
        error: "Unsupported or missing sample rate",
        received: message.sampleRate ?? req.body?.sampleRate,
        supportedRates: [...VALID_SAMPLE_RATES],
      });
    }

    const geminiAudio = await synthesizeWithGemini({
      text: text.trim(),
      voiceId,
    });

    const outputPcm = resamplePcm16Mono(
      geminiAudio.pcm,
      geminiAudio.sampleRate,
      requestedSampleRate
    );

    console.log("Gemini mimeType:", geminiAudio.mimeType || "[missing]");
    console.log("Gemini sample rate:", geminiAudio.sampleRate);
    console.log("Gemini PCM bytes:", geminiAudio.pcm.length);
    console.log("Output sample rate:", requestedSampleRate);
    console.log("Output PCM bytes:", outputPcm.length);
    console.log("Output duration seconds:", (outputPcm.length / 2 / requestedSampleRate).toFixed(3));
    console.log("TTS completed ms:", Date.now() - startedAt);

    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", outputPcm.length);
    res.end(outputPcm);
  } catch (error) {
    console.error("Gemini TTS error:", {
      requestId,
      message: error.message,
      stack: error.stack,
    });

    if (!res.headersSent) {
      res.status(500).json({
        error: "Gemini TTS failed",
        requestId,
        detail: error.message,
      });
    }
  }
}

app.post("/", handleTTS);
app.post("/tts", handleTTS);

app.use((error, req, res, next) => {
  console.error("Unhandled Express error:", error);
  if (res.headersSent) return next(error);
  res.status(400).json({
    error: "Invalid request",
    detail: error.message,
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Gemini TTS webhook running on port ${port}`);
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Default voice: ${DEFAULT_VOICE_ID}`);
  console.log(`Fallback sample rate: ${DEFAULT_SAMPLE_RATE}`);
});
