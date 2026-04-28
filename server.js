import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(express.json({ limit: "10mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Health check pour vérifier que Render fonctionne
app.get("/", (req, res) => {
  res.status(200).send("Gemini 3.1 Flash TTS webhook for Vapi is running.");
});

// Petit resampler simple PCM 16-bit mono
function resamplePcm16Mono(inputBuffer, inputRate, outputRate) {
  if (inputRate === outputRate) return inputBuffer;

  const inputSamples = new Int16Array(
    inputBuffer.buffer,
    inputBuffer.byteOffset,
    inputBuffer.length / 2
  );

  const outputLength = Math.round(inputSamples.length * outputRate / inputRate);
  const outputSamples = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = Math.round(i * inputRate / outputRate);
    outputSamples[i] = inputSamples[Math.min(sourceIndex, inputSamples.length - 1)];
  }

  return Buffer.from(outputSamples.buffer);
}

// Endpoint que Vapi va appeler
app.post("/tts", async (req, res) => {
  try {
    console.log("Vapi request body:", JSON.stringify(req.body, null, 2));

    const text =
      req.body?.message?.text ||
      req.body?.text ||
      "Bonjour, ceci est un test de voix Gemini.";

    // Vapi envoie souvent sampleRate ici
const requestedSampleRate = 24000;

    // Dans Vapi, mets Voice ID = Aoede
    const voiceId =
      req.body?.voice?.voiceId ||
      req.body?.voiceId ||
      "Aoede";

    const ttsPrompt = `
Audio Profile:
A helpful and professional personal assistant.

Director's note:
Style: Empathetic.
Pace: Rapid Fire.
Accent: parisian accent french.
Tone: steady, efficient, and authoritative.
Voice: Aoede.
Voice character: breezy, middle pitch.

Speaking instructions:
Speak in French.
Use a fast, energetic rhythm with almost no dead air.
Keep sentences short and slightly overlapping, like Rapid Fire.
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
          parts: [
            {
              text: ttsPrompt
            }
          ]
        }
      ],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceId
            }
          }
        }
      }
    });

    const audioPart = response.candidates?.[0]?.content?.parts?.find(
      (part) => part.inlineData?.data
    );

    if (!audioPart) {
      console.error("No audio returned from Gemini:", JSON.stringify(response, null, 2));
      return res.status(500).json({
        error: "No audio returned from Gemini"
      });
    }

    // Gemini TTS renvoie du PCM 16-bit mono à 24000 Hz
    const geminiPcmBuffer = Buffer.from(audioPart.inlineData.data, "base64");

    const outputBuffer = resamplePcm16Mono(
      geminiPcmBuffer,
      24000,
      requestedSampleRate
    );

    // Vapi Custom TTS veut du raw PCM, pas un fichier WAV, pas du JSON
    res.setHeader("Content-Type", "audio/L16");
    res.setHeader("X-Sample-Rate", String(requestedSampleRate));
    res.setHeader("X-Channels", "1");
    res.status(200).send(outputBuffer);

  } catch (error) {
    console.error("Gemini TTS error:", error);
    res.status(500).json({
      error: "Gemini TTS failed",
      detail: error.message
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Gemini TTS webhook running on port ${port}`);
});
