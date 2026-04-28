import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json({ limit: "10mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

app.get("/", (req, res) => {
  res.status(200).send("Gemini 3.1 Flash TTS webhook for Vapi is running.");
});

app.get("/tts", (req, res) => {
  res.status(200).send("TTS endpoint alive. Vapi must POST here.");
});

// Gemini TTS sort en PCM 16-bit mono 24000 Hz.
// Vapi demande parfois 8000, 16000, 22050 ou 24000.
// Il faut absolument matcher le sampleRate demandé.
function resamplePcm16MonoLinear(inputBuffer, inputRate, outputRate) {
  if (inputRate === outputRate) return inputBuffer;

  const input = new Int16Array(
    inputBuffer.buffer,
    inputBuffer.byteOffset,
    inputBuffer.length / 2
  );

  const outputLength = Math.floor(input.length * outputRate / inputRate);
  const output = new Int16Array(outputLength);

  const ratio = inputRate / outputRate;

  for (let i = 0; i < outputLength; i++) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;

    const sample1 = input[index] || 0;
    const sample2 = input[index + 1] || sample1;

    output[i] = Math.round(sample1 + (sample2 - sample1) * frac);
  }

  return Buffer.from(output.buffer);
}

async function handleTTS(req, res) {
  try {
    console.log("===== VAPI TTS REQUEST =====");
    console.log(JSON.stringify(req.body, null, 2));

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

    const requestedSampleRate =
      message.sampleRate ||
      req.body?.sampleRate ||
      16000;

    const voiceId =
      req.body?.voice?.voiceId ||
      req.body?.voiceId ||
      "Aoede";

    console.log("Text:", text);
    console.log("Requested sample rate:", requestedSampleRate);
    console.log("Voice:", voiceId);

    const ttsPrompt = `
Audio Profile:
A helpful and professional personal assistant.

Director's note:
Style: Empathetic.
Pace: Rapid Fire.
Accent: American accent.
Tone: steady, efficient, and authoritative.
Voice: Aoede.
Voice character: breezy, middle pitch.

Speaking instructions:
Speak in French.
Use a fast, energetic rhythm with almost no dead air.
Keep sentences short.
Stay warm, empathetic, and professional.
Sound confident, helpful, and commercially sharp.
Do not sound robotic.
Do not sound like a call-center script.
Use a light vocal smile.
Pause briefly before important questions.

Text:
${text}
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [
        {
          parts: [{ text: ttsPrompt }],
        },
      ],
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
      return res.status(500).json({
        error: "No audio returned from Gemini",
      });
    }

    // Gemini TTS = PCM 16-bit mono 24000 Hz, sans WAV header.
    const geminiPcm24k = Buffer.from(audioPart.inlineData.data, "base64");

    // Convertit vers le sampleRate demandé par Vapi.
    const outputPcm = resamplePcm16MonoLinear(
      geminiPcm24k,
      24000,
      requestedSampleRate
    );

    console.log("Gemini PCM bytes:", geminiPcm24k.length);
    console.log("Output PCM bytes:", outputPcm.length);
    console.log("Output sample rate:", requestedSampleRate);

    // IMPORTANT POUR VAPI:
    // Pas audio/wav.
    // Pas audio/L16.
    // Pas JSON.
    // Juste raw PCM bytes.
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", outputPcm.length);
    res.status(200).send(outputPcm);

  } catch (error) {
    console.error("Gemini TTS error:", error);
    res.status(500).json({
      error: "Gemini TTS failed",
      detail: error.message,
    });
  }
}

app.post("/", handleTTS);
app.post("/tts", handleTTS);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Gemini TTS webhook running on port ${port}`);
});
