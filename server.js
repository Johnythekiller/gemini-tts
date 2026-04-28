import express from "express";
import { GoogleGenAI } from "@google/genai";
import pkg from "wavefile";
const { WaveFile } = pkg;

const app = express();
app.use(express.json({ limit: "10mb" }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_RATE = 24000;

app.get("/", (req, res) => {
  res.status(200).send("Gemini 3.1 Flash TTS webhook for Vapi is running.");
});

app.get("/tts", (req, res) => {
  res.status(200).send("TTS endpoint alive. Vapi must POST here.");
});

// ---------- Resampling ----------
function resamplePcmMono16(inputPcmBuffer, fromRate, toRate) {
  if (fromRate === toRate) return inputPcmBuffer;
  const samples = new Int16Array(
    inputPcmBuffer.buffer,
    inputPcmBuffer.byteOffset,
    inputPcmBuffer.length / 2
  );
  const wav = new WaveFile();
  wav.fromScratch(1, fromRate, "16", samples);
  wav.toSampleRate(toRate, { method: "sinc" });
  const out = wav.data.samples;
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

function pcmToWav(pcmBuffer, sampleRate) {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2
  );
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRate, "16", samples);
  return Buffer.from(wav.toBuffer());
}

// ---------- Construit la requête Gemini ----------
function buildGeminiRequest(text, voiceId) {
  const ttsPrompt = `
Audio Profile: helpful and professional personal assistant.
Director's note:
Style: Empathetic. Pace: Rapid Fire. Accent: French. Tone: steady, efficient.
Voice: ${voiceId}.

Speaking instructions:
Speak in French. Fast, energetic rhythm with almost no dead air. Short sentences.
Warm, empathetic, professional. Do not sound robotic.

Text:
${text}
`;
  return {
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text: ttsPrompt }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } },
      },
    },
  };
}

// ---------- Handler Vapi en STREAMING ----------
async function handleTTS(req, res) {
  const t0 = Date.now();
  try {
    console.log("===== VAPI TTS REQUEST =====");
    const message = req.body?.message || {};

    if (message.type && message.type !== "voice-request") {
      return res.status(400).json({
        error: "Invalid message type",
        received: message.type,
      });
    }

    const text =
      message.text ||
      req.body?.text ||
      "Bonjour, ceci est un test de voix Gemini.";

    const requestedSampleRate = Number(
      message.sampleRate || req.body?.sampleRate || 16000
    );

    const voiceId =
      req.body?.voice?.voiceId || req.body?.voiceId || "Aoede";

    console.log(`[${Date.now() - t0}ms] Text: "${text.slice(0, 80)}..."`);
    console.log(`[${Date.now() - t0}ms] Rate: ${requestedSampleRate}, Voice: ${voiceId}`);

    // Démarre la réponse HTTP IMMÉDIATEMENT (chunked)
    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    // Pas de Content-Length -> Node passe automatiquement en Transfer-Encoding: chunked

    // Lance le stream Gemini
    const stream = await ai.models.generateContentStream(
      buildGeminiRequest(text, voiceId)
    );
    console.log(`[${Date.now() - t0}ms] Gemini stream opened`);

    let totalIn = 0;
    let totalOut = 0;
    let firstByteSent = false;

    for await (const chunk of stream) {
      const part = chunk.candidates?.[0]?.content?.parts?.find(
        (p) => p.inlineData?.data
      );
      if (!part) continue;

      const pcm24 = Buffer.from(part.inlineData.data, "base64");
      totalIn += pcm24.length;

      const resampled = resamplePcmMono16(
        pcm24,
        GEMINI_RATE,
        requestedSampleRate
      );
      totalOut += resampled.length;

      res.write(resampled);

      if (!firstByteSent) {
        firstByteSent = true;
        console.log(
          `[${Date.now() - t0}ms] First audio chunk sent (${resampled.length} bytes)`
        );
      }
    }

    res.end();
    console.log(
      `[${Date.now() - t0}ms] Stream done. In=${totalIn}b @24k Out=${totalOut}b @${requestedSampleRate}`
    );
  } catch (error) {
    console.error("Gemini TTS error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Gemini TTS failed", detail: error.message });
    } else {
      res.end();
    }
  }
}

// ---------- Génération non-streaming pour debug ----------
async function generateGeminiPcm24kFull(text, voiceId) {
  const response = await ai.models.generateContent(
    buildGeminiRequest(text, voiceId)
  );
  const audioPart = response.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.data
  );
  if (!audioPart) throw new Error("No audio returned from Gemini");
  return Buffer.from(audioPart.inlineData.data, "base64");
}

app.get("/debug/gemini.wav", async (req, res) => {
  try {
    const text = req.query.text || "Bonjour Didier, ceci est un test.";
    const voiceId = req.query.voice || "Aoede";
    const pcm = await generateGeminiPcm24kFull(text, voiceId);
    const wav = pcmToWav(pcm, GEMINI_RATE);
    res.setHeader("Content-Type", "audio/wav");
    res.status(200).send(wav);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/debug/resampled.wav", async (req, res) => {
  try {
    const text = req.query.text || "Bonjour Didier, ceci est un test.";
    const voiceId = req.query.voice || "Aoede";
    const rate = Number(req.query.rate || 16000);
    const pcm24 = await generateGeminiPcm24kFull(text, voiceId);
    const pcmTarget = resamplePcmMono16(pcm24, GEMINI_RATE, rate);
    const wav = pcmToWav(pcmTarget, rate);
    res.setHeader("Content-Type", "audio/wav");
    res.status(200).send(wav);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/", handleTTS);
app.post("/tts", handleTTS);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Gemini TTS webhook running on port ${port}`);
});
