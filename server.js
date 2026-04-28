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

async function handleTTS(req, res) {
  try {
    console.log("Vapi TTS request:", JSON.stringify(req.body, null, 2));

    const text =
      req.body?.message?.text ||
      req.body?.text ||
      "Bonjour, ceci est un test de voix Gemini.";

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
      console.error("No audio returned:", JSON.stringify(response, null, 2));
      return res.status(500).json({ error: "No audio returned from Gemini" });
    }

    // Gemini TTS retourne déjà du PCM 16-bit mono 24kHz, sans WAV header.
    const pcmBuffer = Buffer.from(audioPart.inlineData.data, "base64");

    // IMPORTANT: raw PCM, pas WAV, pas JSON.
    res.setHeader("Content-Type", "audio/L16; rate=24000; channels=1");
    res.status(200).send(pcmBuffer);
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
