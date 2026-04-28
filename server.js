import express from "express";
import { GoogleGenAI } from "@google/genai";
import { WaveFile } from "wavefile";

const app = express();
app.use(express.json({ limit: "10mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const GEMINI_RATE = 24000; // Gemini TTS sort toujours du PCM 16-bit mono 24 kHz

app.get("/", (req, res) => {
  res.status(200).send("Gemini 3.1 Flash TTS webhook for Vapi is running.");
});

app.get("/tts", (req, res) => {
  res.status(200).send("TTS endpoint alive. Vapi must POST here.");
});

// ---------- Resampling propre (avec filtrage anti-aliasing) ----------
function resamplePcmMono16(inputPcmBuffer, fromRate, toRate) {
  if (fromRate === toRate) return inputPcmBuffer;

  const samples = new Int16Array(
    inputPcmBuffer.buffer,
    inputPcmBuffer.byteOffset,
    inputPcmBuffer.length / 2
  );

  const wav = new WaveFile();
  wav.fromScratch(1, fromRate, "16", samples);
  wav.toSampleRate(toRate, { method: "sinc" }); // sinc = bonne qualité

  const out = wav.data.samples;
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

// ---------- Wrapper PCM -> WAV (pour endpoints de debug) ----------
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

// ---------- Génération Gemini ----------
async function generateGeminiPcm24k(text, voiceId) {
  const ttsPrompt = `
Audio Profile:
A helpful and professional personal assistant.

Director's note:
Style: Empathetic.
Pace: Rapid Fire.
Accent: French accent.
Tone: steady, efficient, and authoritative.
Voice: ${voiceId}.

Speaking instructions:
Speak in French.
Use a fast, energetic rhythm with almost no dead air.
Keep sentences short.
Stay warm, empathetic, and professional.

Text:
${text}
`;

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text: ttsPrompt }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceId },
        },
      },
    },
  });

  const audioPart = response.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.data
  );

  if (!audioPart) {
    console.error(
      "No audio returned from Gemini:",
      JSON.stringify(response, null, 2)
    );
    throw new Error("No audio returned from Gemini");
  }

  return Buffer.from(audioPart.inlineData.data, "base64");
}

// ---------- Handler principal Vapi ----------
async function handleTTS(req, res) {
  try {
    console.log("===== VAPI TTS REQUEST =====");
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("Body:", JSON.stringify(req.body, null, 2));

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

    console.log("Text:", text);
    console.log("Requested sample rate:", requestedSampleRate);
    console.log("Voice:", voiceId);

    // 1) Gemini -> PCM 16-bit mono 24 kHz
    const geminiPcm24k = await generateGeminiPcm24k(text, voiceId);
    console.log(
      `Gemini PCM bytes=${geminiPcm24k.length} (~${(
        geminiPcm24k.length /
        2 /
        GEMINI_RATE
      ).toFixed(2)}s @24kHz)`
    );

    // 2) Resample propre vers le rate Vapi
    const outputPcm = resamplePcmMono16(
      geminiPcm24k,
      GEMINI_RATE,
      requestedSampleRate
    );
    console.log(
      `Output PCM bytes=${outputPcm.length} (~${(
        outputPcm.length /
        2 /
        requestedSampleRate
      ).toFixed(2)}s @${requestedSampleRate}Hz)`
    );

    // 3) Réponse Vapi : raw PCM 16-bit LE mono, octet-stream
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", outputPcm.length);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(outputPcm);
  } catch (error) {
    console.error("Gemini TTS error:", error);
    res.status(500).json({
      error: "Gemini TTS failed",
      detail: error.message,
    });
  }
}

// ---------- Endpoints de debug ----------
// GET /debug/gemini.wav?text=...&voice=Aoede
// -> WAV au sample rate natif Gemini (24 kHz). Confirme que Gemini sort du son propre.
app.get("/debug/gemini.wav", async (req, res) => {
  try {
    const text =
      req.query.text || "Bonjour Didier, ceci est un test de voix Gemini.";
    const voiceId = req.query.voice || "Aoede";
    const pcm = await generateGeminiPcm24k(text, voiceId);
    const wav = pcmToWav(pcm, GEMINI_RATE);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", 'inline; filename="gemini.wav"');
    res.status(200).send(wav);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// GET /debug/resampled.wav?text=...&rate=16000
// -> WAV au rate cible (le PCM resamplé enveloppé dans un WAV).
// Confirme que le resampler ne casse rien.
app.get("/debug/resampled.wav", async (req, res) => {
  try {
    const text =
      req.query.text || "Bonjour Didier, ceci est un test de voix Gemini.";
    const voiceId = req.query.voice || "Aoede";
    const rate = Number(req.query.rate || 16000);
    const pcm24 = await generateGeminiPcm24k(text, voiceId);
    const pcmTarget = resamplePcmMono16(pcm24, GEMINI_RATE, rate);
    const wav = pcmToWav(pcmTarget, rate);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="gemini-${rate}.wav"`
    );
    res.status(200).send(wav);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/", handleTTS);
app.post("/tts", handleTTS);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Gemini TTS webhook running on port ${port}`);
});
