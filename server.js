// 🔧 Dependencies
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const { SarvamAIClient } = require("sarvamai");
// const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bodyParser = require('body-parser');

// AWS DynamoDB
const { getUser, putUser, scanAllUsers } = require('./config/dynamo');

const rolesByType = {
  "1v1": { prop: ["pm"], opp: ["lo"] },
  "3v3": { prop: ["pm", "dpm", "gw"], opp: ["lo", "dlo", "ow"] },
  "5v5": { prop: ["pm", "dpm", "gw", "member", "whip"], opp: ["lo", "dlo", "ow", "member", "whip"] }
};

const app = express();
// app.use(cors());
// After app = express()

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

app.use(express.json());
app.use(bodyParser.json());

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // Graceful fallback for backward compatibility:
    const fallbackEmail = req.body?.email || req.query?.email || req.body?.email;
    if (fallbackEmail) {
      req.userEmail = fallbackEmail;
      return next();
    }
    return res.status(401).json({ error: 'Access token missing' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.userEmail = decoded.id; // decoded.id is the email
    next();
  });
};

// Token Deduction Helper
async function deductTokens(email, amount, reason = 'UNKNOWN', details = '') {
  try {
    const user = await getUser(email);
    if (!user) return { success: false, error: 'User not found' };

    const currentTokens = user.tokens !== undefined ? user.tokens : 100;
    if (currentTokens < amount) {
      return { success: false, currentTokens, error: 'Insufficient tokens' };
    }

    user.tokens = currentTokens - amount;

    // Log transaction
    user.tokenTransactions = user.tokenTransactions || [];
    user.tokenTransactions.push({
      date: new Date().toISOString(),
      reason: reason,
      amount: -amount,
      details: details
    });

    await putUser(user);
    console.log(`🪙 Deducted ${amount} tokens from ${email} for ${reason} (${details}). New balance: ${user.tokens}`);
    return { success: true, currentTokens: user.tokens };
  } catch (err) {
    console.error('❌ Error deducting tokens:', err);
    return { success: false, error: 'Database error' };
  }
}

const client = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const upload = multer({ storage: multer.memoryStorage() });

//tetstttt
// ==================== UPDATE YOUR EXISTING /api/save-arina-session ROUTE (server.js) ====================
// (Replace the old one I gave you with this — it's the same but now logs more clearly and handles empty summaries safely)

app.post('/api/save-arina-session', async (req, res) => {
  const { email, topic, userTranscripts, aiTranscripts, userSummaries, aiSummaries } = req.body;

  if (!email || !topic || !Array.isArray(userTranscripts) || !Array.isArray(aiTranscripts)) {
    return res.status(400).json({ error: 'Missing required fields: email, topic, userTranscripts[], aiTranscripts[]' });
  }

  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const topicSlug = topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    if (!user.entries?.[topicSlug]) {
      return res.status(404).json({ error: 'Debate entry not found for this topic' });
    }

    const entry = user.entries[topicSlug];

    const userTeam = (entry.stance || '').toLowerCase() === 'proposition' ? 'proposition' : 'opposition';
    const userRole = (entry.userrole || '').toLowerCase() || (userTeam === 'proposition' ? 'pm' : 'lo');

    const oppTeam = userTeam === 'proposition' ? 'opposition' : 'proposition';
    const oppRole = userTeam === 'proposition' ? 'lo' : 'pm';

    if (!entry[userTeam]) entry[userTeam] = {};
    if (!entry[userTeam][userRole]) entry[userTeam][userRole] = { transcript: [], summary: [], aifeedback: {} };
    if (!entry[oppTeam]) entry[oppTeam] = {};
    if (!entry[oppTeam][oppRole]) entry[oppTeam][oppRole] = { transcript: [], summary: [], aifeedback: {} };

    // === KEEP ADDING (append every time this route is called) ===
    const userBlock = entry[userTeam][userRole];
    userBlock.transcript.push(...userTranscripts.map(t => typeof t === 'string' ? t : t.text || ''));

    const oppBlock = entry[oppTeam][oppRole];
    oppBlock.transcript.push(...aiTranscripts.map(t => typeof t === 'string' ? t : t.text || ''));

    if (Array.isArray(userSummaries) && userSummaries.length > 0) {
      userBlock.summary.push(...userSummaries);
    }
    if (Array.isArray(aiSummaries) && aiSummaries.length > 0) {
      oppBlock.summary.push(...aiSummaries);
    }

    entry.updatedAt = new Date().toISOString();
    await putUser(user);

    console.log(`✅ Arina session UPDATED in DynamoDB → ${userTranscripts.length} user turns | ${aiTranscripts.length} AI turns saved for ${email}`);
    res.status(200).json({ success: true, message: 'Transcript + Summary appended successfully' });
  } catch (err) {
    console.error('❌ Error saving Arina session:', err);
    res.status(500).json({ error: 'Failed to save to DynamoDB' });
  }
});



//CALLING ARINA.JSX API - UPDATED BY ANIKET
// ✅ FIXED & IMPROVED TTS ROUTE

// app.post('/api/tts', async (req, res) => {
//   try {
//     const { text, speaker } = req.body; // speaker is the voice name

//     const response = await client.textToSpeech.convert({
//       text,
//       target_language_code: "en-IN",
//       speaker: speaker || 'manisha', // fallback to 'manisha'
//       pitch: 0.1,
//       pace: 0.8,
//       loudness: 1.7,
//       speech_sample_rate: 24000,
//       enable_preprocessing: true,
//       model: "bulbul:v2"
//     });

//     const base64Audio = response.audios?.[0];
//     if (!base64Audio) {
//       throw new Error("No audio data received");
//     }

//     res.json({ audioBase64: base64Audio });
//   } catch (error) {
//     console.error("TTS Error:", error);
//     res.status(500).json({ error: error.message });
//   }
// });

const ELEVENLABS_VOICES = {
  ai_1v1: 'pFZP5JQG7iQjIQuC4Bku', // Lily (Female)
  pm: 'ErXwobaYiN019PkySvjV',     // Antoni (Male)
  dpm: 'pNInz6obpgDQGcFmaJgB',    // Adam (Male)
  gw: 'nPczCjzI2devNBz1zQrb',     // Brian (Male)
  lo: 'pFZP5JQG7iQjIQuC4Bku',     // Lily (Female)
  dlo: 'EXAVITQu4vr4xnSDxMaL',    // Bella (Female)
  ow: 'pFZP5JQG7iQjIQuC4Bku',     // Lily (Female)
  default: 'pFZP5JQG7iQjIQuC4Bku'
};

app.post('/api/tts', async (req, res) => {
  try {
    const { text, speaker, voicePlan, role, email } = req.body;

    // Guard: reject empty or whitespace-only text immediately
    const cleanText = (typeof text === 'string' ? text : '').trim();
    if (!cleanText) {
      return res.status(400).json({ error: 'Text is required and must not be empty.' });
    }

    console.log(`[TTS Route] Request received: voicePlan=${voicePlan}, speaker=${speaker}, role=${role}, email=${email}`);

    if (voicePlan === 'Lite') {
      // Lite mode — Sarvam bulbul:v2 (faster, lighter)
      // Map v3 speaker names → v2-compatible equivalents
      const v2SpeakerMap = {
        // v3 males → v2 males
        rahul: 'abhilash', rohan: 'karun', amit: 'hitesh',
        dev: 'abhilash', varun: 'karun', manan: 'hitesh',
        // v3 females → v2 females
        ritu: 'manisha', priya: 'anushka', neha: 'arya',
        simran: 'manisha', kavya: 'anushka', shruti: 'arya',
        // v2 names pass through unchanged
        manisha: 'manisha', anushka: 'anushka', arya: 'arya',
        abhilash: 'abhilash', karun: 'karun', hitesh: 'hitesh', vidya: 'vidya'
      };
      const rawSpeaker = speaker || 'manisha';
      const liteSpeaker = v2SpeakerMap[rawSpeaker] || 'manisha';
      console.log(`[TTS Route] Lite mode — bulbul:v2 speaker: ${rawSpeaker} → ${liteSpeaker}`);
      const lightRes = await client.textToSpeech.convert({
        text: cleanText,
        target_language_code: "en-IN",
        speaker: liteSpeaker,
        speech_sample_rate: 16000,
        enable_preprocessing: false,
        model: "bulbul:v2"
      });
      const lightAudio = lightRes.audios?.[0];
      if (!lightAudio) throw new Error("No audio data received from Sarvam (Lite)");
      return res.json({ audioBase64: lightAudio });
    }

    // Pro mode — Sarvam bulbul:v3 (best quality)
    let targetSpeaker = speaker || 'ritu';
    if (targetSpeaker === 'manisha') {
      targetSpeaker = 'ritu';
      console.log(`[TTS Route] Mapping speaker 'manisha' → 'ritu' for bulbul:v3`);
    }

    console.log(`[TTS Route] Requesting Sarvam voice using bulbul:v3: ${targetSpeaker}...`);
    const response = await client.textToSpeech.convert({
      text: cleanText,
      target_language_code: "en-IN",
      speaker: targetSpeaker,
      speech_sample_rate: 16000,  // Lower = faster generation, still crisp
      enable_preprocessing: false, // Skip preprocessing — saves 200-400ms per call
      model: "bulbul:v3"
    });
    const base64Audio = response.audios?.[0];
    if (!base64Audio) throw new Error("No audio data received from Sarvam");
    res.json({ audioBase64: base64Audio });
  } catch (error) {
    const fs = require('fs');
    const path = require('path');
    const axiosErrorData = error.response ? (error.response.data instanceof Buffer ? error.response.data.toString('utf8') : JSON.stringify(error.response.data)) : null;

    console.error("TTS Error:", error.message || error);
    if (axiosErrorData) {
      console.error("TTS Detailed Error Response:", axiosErrorData);
    }

    const logMessage = `[${new Date().toISOString()}] TTS Error: ${error.message}\n` +
      `Stack: ${error.stack}\n` +
      `Axios Response Data: ${axiosErrorData || 'N/A'}\n` +
      `Request Body: ${JSON.stringify(req.body)}\n` +
      `-------------------------------------------\n`;

    try {
      fs.appendFileSync(path.join(__dirname, 'tts_error.log'), logMessage);
    } catch (fsErr) {
      console.error("Failed to write to tts_error.log:", fsErr);
    }

    res.status(500).json({ error: error.message || "TTS Request Failed", details: axiosErrorData || undefined });
  }
});

// --- YOUR API KEY ---


// const upload = multer({ storage: multer.memoryStorage() });

// app.post('/evaluate', upload.single('audio'), async (req, res) => {
//     try {
//         const { targetText } = req.body;
//         if (!req.file) return res.status(400).json({ error: "No audio received" });

//         const model = genAI.getGenerativeModel({
//             model: "gemini-2.5-flash",           // ← Best free model right now (250/day)
//             generationConfig: {
//                 responseMimeType: "application/json"
//             }
//         });

//         const prompt = `
// Target Text: "${targetText}"

// You are a very very strict but helpful English pronunciation coach.
// rate very strictly, if bad below 40
// Do not autocorrect. 
// CRITICAL RULES:
// - If no clear human voice → 
//   {"score": 0, "overall_feedback": "No voice detected. Please speak clearly into the microphone.", "phonetic_target": "", "phonetic_heard": "", "mistakes": []}
// - Otherwise analyze phonetically with IPA.

// Return ONLY this JSON:

// {
//   "score": number (0-100),
//   "overall_feedback": "one short encouraging sentence",
//   "phonetic_target": "full IPA of target sentence",
//   "phonetic_heard": "full IPA of what you actually heard",
//   "mistakes": [
//     {
//       "word": "the word",
//       "user_pronunciation": "IPA you heard",
//       "correct_phoneme": "correct IPA",
//       "issue": "short description",
//       "how_to_correct": "how to fix it (1-2 sentences)"
//     }
//   ]
// }
// `;

//         const result = await model.generateContent([
//             { text: prompt },
//             {
//                 inlineData: {
//                     data: req.file.buffer.toString('base64'),
//                     mimeType: "audio/wav"
//                 }
//             }
//         ]);

//         const jsonString = await result.response.text();
//         const data = JSON.parse(jsonString);

//         res.json(data);

//     } catch (error) {
//         console.error("ERROR:", error.message);
//         res.status(500).json({ error: "Server error", details: error.message });
//     }
// });

// ADD THIS ENTIRE BLOCK AT THE VERY END OF YOUR SERVER FILE (after the existing app.post('/evaluate', ...) route)
// // ====================== NEW PROGRESS ENDPOINTS ======================
// app.post('/get-user-progress', async (req, res) => {
//   const { email } = req.body;
//   if (!email) return res.status(400).json({ error: "Email required" });

//   try {
//     const user = await getUser(email);
//     if (!user) return res.status(404).json({ error: "User not found" });

//     res.json({ videoProgress: user.videoProgress || {} });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Server error" });
//   }
// });

// app.post('/save-video-progress', async (req, res) => {
//   const { email, videoId, pronunciationScore, understandingScore, transcription, pronunciationFeedback, understandingFeedback, mistakes, completedAt } = req.body;

//   if (!email || !videoId) return res.status(400).json({ error: "Missing email or videoId" });

//   try {
//     let user = await getUser(email);
//     if (!user) return res.status(404).json({ error: "User not found" });

//     if (!user.videoProgress) user.videoProgress = {};

//     const avgScore = Math.round((pronunciationScore + understandingScore) / 2);

//     user.videoProgress[videoId] = {
//       pronunciationScore,
//       understandingScore,
//       avgScore,
//       transcription: transcription || "",
//       pronunciationFeedback,
//       understandingFeedback,
//       mistakes: mistakes || [],
//       completedAt: completedAt || Date.now()
//     };

//     await putUser(user);
//     res.json({ success: true });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Failed to save progress" });
//   }
// });
// app.post('/evaluate-pronunciation-and-understanding', upload.single('audio'), async (req, res) => {
//   try {
//     const summary = req.body.summary;
//     if (!summary) {
//       return res.status(400).json({ error: "No summary provided" });

//     const result = await model.generateContent([
//       { text: prompt },
//       {
//         inlineData: {
//           data: req.file.buffer.toString('base64'),
//           mimeType: "audio/wav"
//         }
//       }
//     ]);

//     const responseText = await result.response.text();
//     const data = JSON.parse(responseText);

//     // Optional safety: ensure required fields exist
//     if (!data.transcription) data.transcription = "";
//     if (!data.mistakes) data.mistakes = [];

//     res.json(data);
//   } catch (error) {
//     console.error("ERROR in /evaluate-pronunciation-and-understanding:", error.message);
//     res.status(500).json({
//       error: "Server error during analysis",
//       details: error.message
//     });
//   }
// });

// app.post('/evaluate', upload.single('audio'), async (req, res) => {
//   try {
//     const { targetText } = req.body;
//     if (!req.file) return res.status(400).json({ error: "No audio received" });
//     const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
//     const prompt = `
// Target Text: "${targetText}"

// You are a very very strict but helpful English pronunciation coach.
// rate very strictly, if bad below 40
// Do not autocorrect. 
// CRITICAL RULES:
// - If no clear human voice → 
//   {"score": 0, "overall_feedback": "No voice detected. Please speak clearly into the microphone.", "phonetic_target": "", "phonetic_heard": "", "mistakes": []}
// - Otherwise analyze phonetically with IPA.

// Return ONLY this JSON:

// {
//   "score": number (0-100),
//   "overall_feedback": "one short encouraging sentence",
//   "phonetic_target": "full IPA of target sentence",
//   "phonetic_heard": "full IPA of what you actually heard",
//   "mistakes": [
//     {
//       "word": "the word",
//       "user_pronunciation": "IPA you heard",
//       "correct_phoneme": "correct IPA",
//       "issue": "short description",
//       "how_to_correct": "how to fix it (1-2 sentences)"
//     }
//   ]
//  }
//  `;
//     const result = await model.generateContent([{ text: prompt }, { inlineData: { data: req.file.buffer.toString('base64'), mimeType: "audio/wav" } }]);
//     const data = JSON.parse(await result.response.text());
//     res.json(data);
//   } catch (error) {
//     console.error("ERROR:", error.message);
//     res.status(500).json({ error: "Server error", details: error.message });
//   }
// });
app.post('/get-user-progress', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ videoProgress: user.videoProgress || {} });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post('/save-video-progress', async (req, res) => {
  const { email, videoId, pronunciationScore, understandingScore, transcription, pronunciationFeedback, understandingFeedback, mistakes, completedAt } = req.body;

  if (!email || !videoId) return res.status(400).json({ error: "Missing email or videoId" });

  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.videoProgress) user.videoProgress = {};

    const avgScore = Math.round((pronunciationScore + understandingScore) / 2);

    user.videoProgress[videoId] = {
      pronunciationScore,
      understandingScore,
      avgScore,
      transcription: transcription || "",
      pronunciationFeedback,
      understandingFeedback,
      mistakes: mistakes || [],
      completedAt: completedAt || Date.now()
    };

    await putUser(user);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save progress" });
  }
});

app.post('/evaluate-pronunciation-and-understanding', authenticateToken, upload.single('audio'), async (req, res) => {
  try {
    const summary = req.body.summary;
    console.log("BODY:", req.body);
    console.log("FILE:", req.file);
    if (!summary) {
      return res.status(400).json({ error: "No summary provided" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No audio received" });
    }

    const email = req.userEmail;
    const tokenCheck = await deductTokens(email, 3, 'SPEECH_EVAL', 'Speech & pronunciation evaluation (Sarvam AI)');
    if (!tokenCheck.success) {
      return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
    }

    // 1. Transcribe using Sarvam STT (saaras:v3)
    let transcription = '';
    try {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', req.file.buffer, {
        filename: req.file.originalname || 'speech.wav',
        contentType: req.file.mimetype || 'audio/wav',
      });
      form.append('model', 'saaras:v3');
      form.append('mode', 'transcribe');
      form.append('language_code', 'en-IN');

      const sttRes = await axios.post('https://api.sarvam.ai/speech-to-text', form, {
        headers: {
          ...form.getHeaders(),
          'api-subscription-key': process.env.SARVAM_API_KEY
        }
      });
      transcription = sttRes.data.transcript || '';
    } catch (sttErr) {
      console.warn("Sarvam STT failed with form-data require, trying global FormData:", sttErr.message);
      if (typeof FormData !== 'undefined') {
        const formData = new FormData();
        const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' });
        formData.append('file', blob, req.file.originalname || 'speech.wav');
        formData.append('model', 'saaras:v3');
        formData.append('mode', 'transcribe');
        formData.append('language_code', 'en-IN');
        const sttRes = await axios.post('https://api.sarvam.ai/speech-to-text', formData, {
          headers: {
            'api-subscription-key': process.env.SARVAM_API_KEY
          }
        });
        transcription = sttRes.data.transcript || '';
      } else {
        throw sttErr;
      }
    }

    console.log("🎙️ Sarvam STT Transcription:", transcription);

    if (!transcription || transcription.trim().length === 0) {
      return res.json({
        transcription: "",
        pronunciationScore: 0,
        pronunciationFeedback: "We couldn't hear any clear speech. Please check your mic and try speaking closer to it.",
        understandingScore: 0,
        understandingFeedback: "No content could be analyzed because no speech was detected in the audio.",
        mistakes: []
      });
    }

    // 2. Evaluate transcription and pronunciation against summary using Sarvam LLM (sarvam-105b-conversations)
    const prompt = `
Target Summary: ${JSON.stringify(summary)}
User's Transcribed Speech: "${transcription}"

You are a world-class English pronunciation coach, public speaking mentor, and content evaluator — extremely critical and strict yet encouraging in written feedback.
Analyze the user's speech transcript compared to the target summary and evaluate pronunciation, content matches, and sentence formation.

Return ONLY this exact JSON (no extra text, no markdown, no explanations, no backticks, no markdown blocks, no think tags):

{
  "transcription": "${transcription.replace(/"/g, '\\"')}",
  "pronunciationScore": number (0-100, extremely strict: deduct heavily for stuttering, poor pacing, incorrect syllable emphasis, and clarity issues. Average speeches score 45-65; above 85 is reserved for perfect native-level delivery),
  "pronunciationFeedback": "one short, encouraging paragraph (2-4 sentences) focused only on pronunciation, accent, pacing, and clarity",
  "understandingScore": number (0-100, extremely strict: evaluate conceptual coverage, Hook, Transition, Credibility, and Structure. If key points are missing or coherence/grammar is average, grade below 60),
  "understandingFeedback": "beautiful, motivational paragraph matching the target summary, covering Hook, Transition, Credibility, and Structure",
  "mistakes": [
    {
      "word": "the mispronounced word",
      "user_pronunciation": "human-readable phonetic spelling of what the user said for this word, using syllable separation with · (e.g., 'en·vai·uh·muhnt')",
      "correct_pronunciation": "correct human-readable phonetic spelling for the word, using syllable separation with · (e.g., 'en·vai·uh·muhnt')",
      "issue": "short clear description of the pronunciation issue",
      "how_to_correct": "1-2 sentence practical tip to improve"
    }
  ]
}

CRITICAL RULES:
- SCORING MUST BE EXTREMELY CRITICAL AND STRICT. Deduct points heavily for any flaw. Standard/average responses should reside in the 40-65 range. Above 80 requires near-flawless performance.
- Use human-readable phonetic spellings (not IPA) in mistakes, with syllables separated by ·.
- UnderstandingScore = accuracy of content match (60%) + sentence formation/grammar/coherence (40%).
- Be very strict on scores but always kind and constructive in feedback.
- For mistakes, only include entries for clearly mispronounced words (max 5 items).
`;

    const chatUrl = process.env.SARVAM_API_URL || 'https://api.sarvam.ai/v1/chat/completions';
    const chatResponse = await axios.post(chatUrl, {
      model: 'sarvam-105b-conversations',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      reasoning_effort: null
    }, {
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const rawText = chatResponse.data.choices?.[0]?.message?.content || "{}";

    let data;
    try {
      let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '');
      }
      data = JSON.parse(cleaned.trim());
    } catch (parseErr) {
      console.warn("Sarvam LLM JSON parse failed, trying direct regex cleanup:", parseErr, rawText);
      data = {
        transcription: transcription,
        pronunciationScore: 70,
        pronunciationFeedback: "Good attempt! Make sure to speak clearly and maintain consistent pacing throughout your speech.",
        understandingScore: 70,
        understandingFeedback: "You covered some points from the video but can align more closely with the structure in the target summary.",
        mistakes: []
      };
    }

    if (!data.transcription) data.transcription = transcription;
    if (!data.mistakes) data.mistakes = [];

    res.json(data);

  } catch (error) {
    console.error("ERROR in /evaluate-pronunciation-and-understanding (Sarvam):", error.response?.data || error.message);
    res.status(500).json({
      error: "Server error during analysis",
      details: error.message
    });
  }
});


app.post('/evaluate', authenticateToken, upload.single('audio'), async (req, res) => {
  try {
    const { targetText } = req.body;
    if (!req.file) return res.status(400).json({ error: "No audio received" });

    const email = req.userEmail;
    const tokenCheck = await deductTokens(email, 3, 'SPEECH_EVAL', 'Pronunciation coaching evaluation');
    if (!tokenCheck.success) {
      return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });
    const prompt = `
Target Text: "${targetText}"

You are a very very strict but helpful English pronunciation coach.
rate very very strictly, if bad below 30
Do not autocorrect. 
CRITICAL RULES:
- If no clear human voice → 
  {"score": 0, "overall_feedback": "No voice detected. Please speak clearly into the microphone.", "phonetic_target": "", "phonetic_heard": "", "mistakes": []}
- Otherwise analyze phonetically with human-readable spellings.

Return ONLY this JSON:

{
  "score": number (0-100),
  "overall_feedback": "one short encouraging sentence",
  "phonetic_target": "full human-readable phonetic spelling of target sentence, using syllable separation with · (e.g., 'en·vai·uh·muhnt')",
  "phonetic_heard": "full human-readable phonetic spelling of what you actually heard, using syllable separation with · (e.g., 'en·vai·uh·muhnt')",
  "mistakes": [
    {
      "word": "the word",
      "user_pronunciation": "human-readable phonetic spelling you heard, using syllable separation with · (e.g., 'en·vai·uh·muhnt')",
      "correct_pronunciation": "correct human-readable phonetic spelling, using syllable separation with · (e.g., 'en·vai·uh·muhnt')",
      "issue": "short description",
      "how_to_correct": "how to fix it (1-2 sentences)"
    }
  ]
 }
 `;
    const result = await model.generateContent([{ text: prompt }, { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype || "audio/wav" } }]);
    const data = JSON.parse(await result.response.text());
    res.json(data);
  } catch (error) {
    console.error("ERROR:", error.message);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});



// 🔌 MongoDB Connection
// mongoose.connect(process.env.MONGO_URI)
//   .then(() => console.log("✅ Connected to MongoDB Atlas"))
//   .catch(err => console.error("❌ MongoDB Error:", err));
// // 📝 AI Judge Feedback Subschema (Per Role)
// const RoleFeedbackSchema = new mongoose.Schema({
//   feedbackText: { type: String, default: "" },
//   logic: { type: Number, default: 0 },
//   clarity: { type: Number, default: 0 },
//   relevance: { type: Number, default: 0 },
//   persuasiveness: { type: Number, default: 0 },
//   depth: { type: Number, default: 0 },
//   evidenceUsage: { type: Number, default: 0 },
//   emotionalAppeal: { type: Number, default: 0 },
//   rebuttalStrength: { type: Number, default: 0 },
//   structure: { type: Number, default: 0 },
//   overall: { type: Number, default: 0 }
// }, { _id: false });


// // 📝 AI Judge Feedback per team (Map of roles)
// const TeamFeedbackSchema = new mongoose.Schema({
//   pm: RoleFeedbackSchema,
//   dpm: RoleFeedbackSchema,
//   gw: RoleFeedbackSchema,
//   member: RoleFeedbackSchema,
//   whip: RoleFeedbackSchema,
//   lo: RoleFeedbackSchema,
//   dlo: RoleFeedbackSchema,
//   ow: RoleFeedbackSchema
// }, { _id: false });

// // 🧠 Full AI Judgement Subschema
// const AIFeedbackSchema = new mongoose.Schema({
//   proposition: TeamFeedbackSchema,
//   opposition: TeamFeedbackSchema,
//   winner: String,
//   reason: String
// }, { _id: false });

// // 🎤 Debate Role Schema
// const RoleSchema = new mongoose.Schema({
//   prep: String,
//   notes:{ type: String, default: "" },
//   transcript: [String],
//   summary: [String],
//   aifeedback: { type: RoleFeedbackSchema, default: () => ({}) },

// }, { _id: false });

// // 🗣️ Entry Schema for each debate
// const EntrySchema = new mongoose.Schema({
//   type: { type: String, default: "Beginner" },
//   debateType: { type: String, default: "1v1" }, // "1v1", "3v3", "5v5"
//   topic: String,
//   stance: String,
//   userrole: String,
//   createdAt: { type: Date, default: Date.now },
//   updatedAt: { type: Date, default: Date.now },

//   proposition: {
//     pm: RoleSchema,
//     dpm: RoleSchema,
//     gw: RoleSchema,
//     member: RoleSchema,
//     whip: RoleSchema
//   },

//   opposition: {
//     lo: RoleSchema,
//     dlo: RoleSchema,
//     ow: RoleSchema,
//     member: RoleSchema,
//     whip: RoleSchema
//   },

//   winner: { type: String, default: "" },
//   reason: { type: String, default: "" }
// }, { _id: false });


// // 👤 User Schema & Model
// const UserSchema = new mongoose.Schema({
//   displayName: String,
//   email: { type: String, unique: true },
//   password: String,
//   entries: {
//     type: Map,
//     of: EntrySchema,
//     default: {}
//   }
// });
// const User = mongoose.model("User", UserSchema);



// ✅ SIGNUP
// app.post('/api/signup', async (req, res) => {
//   try {
//     const { email, password, displayName } = req.body;
//     const existingUser = await User.findOne({ email });
//     if (existingUser) return res.status(400).json({ error: 'Email already exists' });

//     const hashedPassword = await bcrypt.hash(password, 10);
//     const newUser = await User.create({ email, password: hashedPassword, displayName });

//     res.status(201).json({ message: 'User created', user: { email, displayName } });
//   } catch (err) {
//     console.error("Signup error:", err);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });

// app.get('/api/ping', (req, res) => {
//   res.json({ message: 'pong 🏓 from Debattlex backend' });
// });

// --- Firebase / Google ID Token Verification helper ---
let publicCertsCache = null;
let publicCertsExpiry = 0;
let googleJwksCache = null;
let googleJwksExpiry = 0;

// Firebase x509 certs (for Firebase ID tokens)
async function getFirebasePublicCert(kid) {
  const now = Date.now();
  if (!publicCertsCache || now > publicCertsExpiry) {
    const certsResponse = await axios.get('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    let maxAge = 3600;
    const cacheControl = certsResponse.headers['cache-control'];
    if (cacheControl) {
      const match = cacheControl.match(/max-age=(\d+)/);
      if (match) maxAge = parseInt(match[1], 10);
    }
    publicCertsCache = certsResponse.data;
    publicCertsExpiry = now + (maxAge * 1000);
  }
  const cert = publicCertsCache[kid];
  if (!cert) throw new Error(`Invalid kid: Firebase public key not found (kid=${kid})`);
  return cert;
}

// Google OIDC JWKS (for Google Sign-In ID tokens from React Native)
async function getGooglePublicKey(kid) {
  const now = Date.now();
  if (!googleJwksCache || now > googleJwksExpiry) {
    const jwksResponse = await axios.get('https://www.googleapis.com/oauth2/v3/certs');
    let maxAge = 3600;
    const cacheControl = jwksResponse.headers['cache-control'];
    if (cacheControl) {
      const match = cacheControl.match(/max-age=(\d+)/);
      if (match) maxAge = parseInt(match[1], 10);
    }
    googleJwksCache = jwksResponse.data.keys; // array of JWK objects
    googleJwksExpiry = now + (maxAge * 1000);
  }
  const jwk = googleJwksCache.find(k => k.kid === kid);
  if (!jwk) throw new Error(`Invalid kid: Google OIDC public key not found (kid=${kid})`);
  // Convert JWK → PEM for jsonwebtoken
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return publicKey.export({ type: 'spki', format: 'pem' });
}

async function verifyFirebaseToken(idToken) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID is not configured in backend .env');
  }
  const decodedToken = jwt.decode(idToken, { complete: true });
  if (!decodedToken || !decodedToken.header || !decodedToken.header.kid) {
    throw new Error('Invalid ID token structure');
  }
  const kid = decodedToken.header.kid;
  const iss = decodedToken.payload && decodedToken.payload.iss;

  console.log(`[Auth] Token iss=${iss}, kid=${kid}`);

  if (iss === 'accounts.google.com' || iss === 'https://accounts.google.com') {
    // Google Sign-In token (OIDC) — verify against Google JWKS
    const publicKey = await getGooglePublicKey(kid);
    return jwt.verify(idToken, publicKey, { algorithms: ['RS256'] });
  } else {
    // Firebase ID token — verify against Firebase x509 certs
    const publicCert = await getFirebasePublicCert(kid);
    return jwt.verify(idToken, publicCert, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`
    });
  }
}


// Check if Google user exists
app.post('/api/check-google-user', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await getUser(email);
    if (user) {
      const token = jwt.sign({ id: email }, process.env.JWT_SECRET, { expiresIn: '1d' });
      return res.json({ exists: true, user: { email, displayName: user.displayName, phoneNumber: user.phoneNumber }, token });
    }
    res.json({ exists: false });
  } catch (err) {
    console.error("Check Google user error:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sign up new Google user with verified phone OTP
app.post('/api/signup-google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    let verifiedPayload;
    try {
      verifiedPayload = await verifyFirebaseToken(idToken);
    } catch (tokenErr) {
      console.error("Token verification failed:", tokenErr.message);
      console.error("Token verification stack:", tokenErr.stack);
      return res.status(401).json({ error: 'Invalid or expired token', details: tokenErr.message });
    }

    const email = verifiedPayload.email;
    const displayName = verifiedPayload.name || verifiedPayload.displayName || email.split('@')[0];
    const phoneNumber = verifiedPayload.phone_number || '';

    if (!email) {
      return res.status(400).json({ error: 'Email not found in Firebase token' });
    }

    const existing = await getUser(email);
    if (existing) {
      const token = jwt.sign({ id: email }, process.env.JWT_SECRET, { expiresIn: '1d' });
      return res.json({ message: 'Login successful', user: { email, displayName: existing.displayName, phoneNumber: existing.phoneNumber }, token });
    }

    // Create new user in DynamoDB
    const newUser = {
      email,
      displayName,
      phoneNumber,
      entries: {},
      tokens: 100
    };
    await putUser(newUser);

    const token = jwt.sign({ id: email }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.status(201).json({ message: 'User created successfully', user: { email, displayName, phoneNumber }, token });
  } catch (err) {
    console.error("Signup Google error:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, displayName } = req.body;
    const existing = await getUser(email);
    if (existing) return res.status(400).json({ error: 'Email already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await putUser({ email, password: hashedPassword, displayName, entries: {}, tokens: 100 });
    res.status(201).json({ message: 'User created', user: { email, displayName } });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ GET USER PROFILE
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const email = req.userEmail;
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // exclude password
    const { password, ...safeUser } = user;
    safeUser.plan = safeUser.plan || 'standard';
    res.json({ user: safeUser });
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ UPDATE USER PROFILE
app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const email = req.userEmail;
    const { displayName, password, oldPassword } = req.body;

    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (displayName) user.displayName = displayName;

    if (password && password.trim() !== '') {
      if (!oldPassword) {
        return res.status(400).json({ error: 'Old password is required to set a new password' });
      }
      // verify old password
      const isMatch = await bcrypt.compare(oldPassword, user.password);
      if (!isMatch) {
        return res.status(401).json({ error: 'Incorrect old password' });
      }

      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password, salt);
    }

    await putUser(user);
    res.json({ success: true, message: 'Profile updated' });
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ GET USER TOKENS ROUTE
app.get('/api/user/tokens', authenticateToken, async (req, res) => {
  try {
    const email = req.userEmail;
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const tokenBalance = user.tokens !== undefined ? user.tokens : 100;
    res.json({ tokens: tokenBalance });
  } catch (err) {
    console.error('Error fetching user tokens:', err);
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
});

// ✅ RAZORPAY: CREATE ORDER
app.post('/api/razorpay/order', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body; // e.g. amount in Rupees (e.g. ₹50)
    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const amountInPaise = Math.round(amount * 100);

    // Razorpay key and secret fallback to test values
    const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_pNDbT5K2r5l2zX';
    const keySecret = process.env.RAZORPAY_KEY_SECRET || 'g3rJgB3UjFk3h1X2n4m5y7z9';

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const response = await axios.post('https://api.razorpay.com/v1/orders', {
      amount: amountInPaise,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`
    }, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      orderId: response.data.id,
      amount: response.data.amount,
      keyId: keyId
    });
  } catch (err) {
    console.error("Razorpay order creation failed:", err.response?.data || err.message);
    res.status(500).json({ error: 'Razorpay order creation failed' });
  }
});

// ✅ RAZORPAY: VERIFY SIGNATURE AND ADD TOKENS
app.post('/api/razorpay/verify', authenticateToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, tokenPack } = req.body;
    const email = req.userEmail;

    const keySecret = process.env.RAZORPAY_KEY_SECRET || 'g3rJgB3UjFk3h1X2n4m5y7z9';

    // Perform signature check
    const hmac = crypto.createHmac('sha256', keySecret);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const generatedSignature = hmac.digest('hex');

    if (generatedSignature !== razorpay_signature) {
      console.warn("❌ Razorpay signature mismatch!");
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Sig matches! Add tokens
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let tokensToAdd = 0;
    if (tokenPack === 'pack1') tokensToAdd = 100;
    else if (tokenPack === 'pack2') tokensToAdd = 500;
    else if (tokenPack === 'pack3') tokensToAdd = 1000;
    else if (tokenPack === 'pro') {
      tokensToAdd = 1500;
      user.plan = 'pro'; // Upgrade user plan
    }
    else tokensToAdd = 100; // default fallback

    user.tokens = (user.tokens !== undefined ? user.tokens : 100) + tokensToAdd;

    // Log transaction
    user.tokenTransactions = user.tokenTransactions || [];
    user.tokenTransactions.push({
      date: new Date().toISOString(),
      reason: 'PURCHASE',
      amount: tokensToAdd,
      details: tokenPack === 'pro' ? 'Pro Plan Monthly Pass (1500 Tokens)' : `Token Pack (${tokensToAdd} Tokens)`
    });

    await putUser(user);

    console.log(`✅ User ${email} successfully recharged ${tokensToAdd} tokens! New Balance: ${user.tokens}`);
    res.json({ success: true, message: `Successfully recharged ${tokensToAdd} tokens!`, tokens: user.tokens });
  } catch (err) {
    console.error("Payment verification failed:", err.message);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

app.get('/api/ping', (req, res) => res.json({ message: 'pong 🏓 from Debattlex backend' }));
app.get('/', (req, res) => res.send('<h1>✅ Debattlex Backend is Live!</h1>'));


// ✅ LOGIN
// app.post('/api/login', async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     const user = await User.findOne({ email });
//     if (!user) return res.status(404).json({ error: 'User not found' });

//     const match = await bcrypt.compare(password, user.password);
//     if (!match) return res.status(401).json({ error: 'Invalid credentials' });

//     const token = jwt.sign({ id: user._id }, 'secret123', { expiresIn: '1d' });

//     res.json({
//       message: 'Login successful',
//       user: { email, displayName: user.displayName },
//       token
//     });
//   } catch (err) {
//     console.error("Login error:", err);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });const normalizeDebateType = (raw) => raw.replace(/\s+/g, '').toLowerCase();

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: email }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ message: 'Login successful', user: { email, displayName: user.displayName }, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const normalizeDebateType = (raw) => raw.replace(/\s+/g, '').toLowerCase();

app.get('/', (req, res) => {
  res.send('<h1>✅ Debattlex Backend is Live!</h1>');
});

// COMMIT BY ANIKET 
// ====================== CREATE NEW DEBATE ENTRY (Stepper calls this - POST) ======================
app.post('/api/userdata', async (req, res) => {
  const { email, entry } = req.body;
  if (!email || !entry || !entry.topic || !entry.debateType || !entry.stance || !entry.userrole) {
    return res.status(400).json({ error: 'Missing required fields: email, topic, debateType, stance, userrole' });
  }
  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let key = entry.topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    let uniqueKey = key, counter = 1;
    while (user.entries?.[uniqueKey]) uniqueKey = `${key}_${counter++}`;

    const initializeRoleData = () => ({ prep: "", notes: "", transcript: [], summary: [], aifeedback: {} });
    const normalizedType = normalizeDebateType(entry.debateType);
    const roles = rolesByType[normalizedType] || { prop: ["pm"], opp: ["lo"] };

    const initializedEntry = {
      type: entry.type || "Beginner",
      debateType: normalizedType,
      topic: entry.topic,
      stance: entry.stance,
      userrole: entry.userrole,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      winner: "", reason: "",
      proposition: {}, opposition: {}
    };
    roles.prop.forEach(r => initializedEntry.proposition[r] = initializeRoleData());
    roles.opp.forEach(r => initializedEntry.opposition[r] = initializeRoleData());

    user.entries = user.entries || {};
    user.entries[uniqueKey] = initializedEntry;
    await putUser(user);

    res.status(200).json({ message: 'Entry saved', key: uniqueKey, entries: user.entries });
  } catch (err) {
    console.error('❌ Error saving user entry (POST):', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});



app.patch('/api/saveSummaries', async (req, res) => {
  const { email, summaries } = req.body;
  if (
    !email ||
    !summaries ||
    !summaries.topic ||
    !summaries.debateType ||
    !summaries.stance ||
    !summaries.userrole ||
    !Array.isArray(summaries.points)
  ) {
    return res.status(400).json({
      error: 'Missing required fields: email, topic, debateType, stance, userrole, points[]'
    });
  }
  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const key = summaries.topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    if (!user.entries?.[key]) {
      return res.status(404).json({ error: 'Entry not found for this topic' });
    }

    const entry = user.entries[key];
    const teamKey = summaries.stance === "proposition" ? "proposition" : "opposition";
    const roleKey = summaries.userrole;

    if (!entry[teamKey] || !entry[teamKey][roleKey]) {
      return res.status(400).json({ error: `Role ${roleKey} not found in ${teamKey}` });
    }

    entry[teamKey][roleKey].summary.push(...summaries.points);
    entry.updatedAt = new Date().toISOString();

    await putUser(user);
    res.status(200).json({ message: 'Summaries saved successfully' });
  } catch (err) {
    console.error("❌ Error saving summaries:", err);
    res.status(500).json({ error: 'Failed to save summaries' });
  }
});



// ✅ FETCH ENTRIES (with support for role-based schema)
app.post('/api/fetchEntries', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const user = await getUser(email);   // ← your DynamoDB getUser
    if (!user) return res.status(404).json({ error: 'User not found' });

    const rawEntries = user.entries || {};

    const formattedEntries = Object.entries(rawEntries).reduce((acc, [topicKey, entry]) => {
      const stance = entry.stance?.toLowerCase() || 'proposition';
      const userrole = entry.userrole?.toLowerCase();
      const team = entry[stance] || {};
      const roleData = team?.[userrole] || {};

      acc[topicKey] = {
        type: entry.type || 'beginner',
        debateType: entry.debateType || '1v1',
        topic: entry.topic || topicKey.replace(/_/g, ' '),
        stance,
        userrole,
        createdAt: entry.createdAt || new Date(),
        updatedAt: entry.updatedAt || new Date(),
        winner: entry.winner || "Not determined",
        reason: entry.reason || "No reason provided",
        aiJudgeFeedback: entry.winner && entry.reason ? { winner: entry.winner, reason: entry.reason } : null,
        proposition: entry.proposition || {},
        opposition: entry.opposition || {},
        transcript: roleData.transcript || [],
        summary: roleData.summary || [],
        aifeedback: {
          feedbackText: roleData.aifeedback?.feedbackText || '',
          logic: roleData.aifeedback?.logic || 0,
          clarity: roleData.aifeedback?.clarity || 0,
          relevance: roleData.aifeedback?.relevance || 0,
          persuasiveness: roleData.aifeedback?.persuasiveness || 0,
          depth: roleData.aifeedback?.depth || 0,
          evidenceUsage: roleData.aifeedback?.evidenceUsage || 0,
          emotionalAppeal: roleData.aifeedback?.emotionalAppeal || 0,
          rebuttalStrength: roleData.aifeedback?.rebuttalStrength || 0,
          structure: roleData.aifeedback?.structure || 0,
          overall: roleData.aifeedback?.overall || 0
        }
      };
      return acc;
    }, {});

    // 🔥 SORTED so lastKey = latest debate (DynamoDB fix)
    const sortedEntries = Object.entries(formattedEntries)
      .sort(([, a], [, b]) => new Date(a.createdAt) - new Date(b.createdAt))
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {});

    res.json({
      entries: sortedEntries,
      displayName: user.displayName || 'User',
      email: user.email,
      id: user.email
    });
  } catch (err) {
    console.error('❌ Error fetching entries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});




app.post("/api/getStats", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await getUser(email);
    if (!user) return res.status(404).json({ message: "User not found" });
    const entries = Object.values(user.entries || {});
    const totalDebates = entries.length;
    let wins = 0, losses = 0;
    const winLossHistory = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const stance = entry.stance?.toLowerCase();
      const winner = entry.winner?.toLowerCase();
      if (stance && winner) {
        if (stance === winner) { wins++; winLossHistory.push({ index: i + 1, result: 'win' }); }
        else { losses++; winLossHistory.push({ index: i + 1, result: 'loss' }); }
      }
    }
    const winRate = totalDebates > 0 ? Math.round((wins / totalDebates) * 100) : 0;
    res.json({ totalDebates, winRate, wins, losses, winLossHistory });
  } catch (err) {
    console.error("Error in getStats:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// 🧠 Sarvam AI Integration
app.post('/api/ask', authenticateToken, async (req, res) => {
  const { question, topic, stance, type, transcripts } = req.body;
  if (!question || !topic || !stance || !type || !Array.isArray(transcripts)) {
    return res.status(400).json({ error: 'Missing or invalid fields in /ask request' });
  }
  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 2, 'AI_ASK', '1v1 debate turn response');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }
  try {
    // Only use last 3 transcripts to keep context small and fast
    const recentTranscripts = transcripts.slice(-3);
    const levelLower = (type || 'beginner').toLowerCase();
    let vocabularyInstruction = "";
    if (levelLower === 'beginner') {
      vocabularyInstruction = "Your level is BEGINNER. You MUST use extremely basic, simple English words and short, direct sentences. Avoid any complex, advanced, or fancy vocabulary.";
    } else if (levelLower === 'advanced') {
      vocabularyInstruction = "Your level is ADVANCED. You MUST use sophisticated, rich, advanced English vocabulary, strong rhetorical phrasing, and complex grammatical structures.";
    } else {
      vocabularyInstruction = "Your level is INTERMEDIATE. You MUST use basic to medium, normal formal English suited for regular debaters.";
    }

    const context = `Debate Topic: ${topic}
Stance: ${stance}
Recent exchanges:\n${recentTranscripts.map(t => `${t.speaker}: ${t.text}`).join('\n')}

${vocabularyInstruction}
Reply in first person tone. Continue the debate in medium length based on the following user input:
"${question}"`;
    const response = await client.chat.completions({
      messages: [{ role: 'user', content: context }],
      max_tokens: 250,
      temperature: 0.5,
      reasoning_effort: null
    });
    let answer = response.choices?.[0]?.message?.content || "No response from AI.";
    answer = answer.replace(/<think>[\s\S]*?<\/think>/gi, '');
    answer = answer.replace(/<think>[\s\S]*/gi, '');
    answer = answer.trim();
    res.json({ answer });
  } catch (err) {
    console.error('Sarvam API Error:', err.message || err);
    res.status(500).json({ error: 'Failed to get response from Sarvam AI' });
  }
});



// 🧠 Transcript Summarization
app.post('/api/summarize-transcripts', authenticateToken, async (req, res) => {
  const { userTranscripts, aiTranscripts } = req.body;
  if (!Array.isArray(userTranscripts) || !Array.isArray(aiTranscripts)) {
    return res.status(400).json({ error: 'userTranscripts and aiTranscripts must be arrays' });
  }
  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_SUMMARY', '1v1 debate summary panel');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }
  try {
    const userText = userTranscripts.map(t => t.text).reverse().join(' ');
    const aiText = aiTranscripts.map(t => t.text).reverse().join(' ');
    const userPrompt = `You are a debate analyst. Summarize this debater's speech into exactly 3 very short bullet points about their key highlights and point of view.

Rules:
- Do NOT include labels like "[CLAIM]", "[WEAKNESS]", "[REBUTTAL]", or "[COUNTER]". The opponent should figure those out themselves.
- Keep each bullet point under 20 words.
- Put key highlights, terms, or phrases in **bold** (e.g. **economic impact**).
- Return exactly 3 bullet points starting with a hyphen (e.g., "- Point").

Speech:\n${userText}`;
    const aiPrompt = `You are a debate analyst. Summarize this debater's speech into exactly 3 very short bullet points about their key highlights and point of view.

Rules:
- Do NOT include labels like "[CLAIM]", "[WEAKNESS]", "[REBUTTAL]", or "[COUNTER]". The opponent should figure those out themselves.
- Keep each bullet point under 20 words.
- Put key highlights, terms, or phrases in **bold** (e.g. **economic impact**).
- Return exactly 3 bullet points starting with a hyphen (e.g., "- Point").

Speech:\n${aiText}`;
    const [userRes, aiRes] = await Promise.all([
      client.chat.completions({ messages: [{ role: 'user', content: userPrompt }], max_tokens: 150, temperature: 0.3, reasoning_effort: null }),
      client.chat.completions({ messages: [{ role: 'user', content: aiPrompt }], max_tokens: 150, temperature: 0.3, reasoning_effort: null })
    ]);
    let userSummary = (userRes?.choices?.[0]?.message?.content) ? userRes.choices[0].message.content.trim() : "";
    let aiSummary = (aiRes?.choices?.[0]?.message?.content) ? aiRes.choices[0].message.content.trim() : "";

    userSummary = userSummary.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
    aiSummary = aiSummary.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();

    res.json({ userSummary, aiSummary });
  } catch (err) {
    console.error("❌ Sarvam summary API error:", err.message || err);
    res.status(500).json({ error: "Failed to generate summaries" });
  }
});


// 🎯 Topic Generator

app.post('/api/generate-debate-topic', authenticateToken, async (req, res) => {
  const { interest } = req.body;
  if (!interest) return res.status(400).json({ error: 'Interest is required' });
  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_TOPIC', 'Generate debate topic suggestion');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }
  try {
    const prompt = `Generate only one thought-provoking debate topic with out ' " ' based on : "${interest}".`;
    const response = await client.chat.completions({
      messages: [{ role: 'user', content: prompt }],
      model: "sarvam-105b-conversations",
      reasoning_effort: null
    });
    let generatedTopic = response?.choices?.[0]?.message?.content?.trim() || "";
    generatedTopic = generatedTopic.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
    generatedTopic = generatedTopic.replace(/^["']|["']$/g, '').trim();
    if (generatedTopic.startsWith('\\boxed{') && generatedTopic.endsWith('}')) {
      generatedTopic = generatedTopic.slice(7, -1).trim();
    }
    // Strip prefixes like "Debate Topic:", "Topic:", "**Debate Topic:**"
    generatedTopic = generatedTopic.replace(/^(?:\*\*|\*|#|)?debate topic:?(?:\*\*|\*|)?\s*/i, '').trim();
    generatedTopic = generatedTopic.replace(/^(?:\*\*|\*|#|)?topic:?(?:\*\*|\*|)?\s*/i, '').trim();
    generatedTopic = generatedTopic.replace(/^["']|["']$/g, '').trim();
    res.json({ generatedTopic });
  } catch (err) {
    console.error('Sarvam API Error:', err.message || err);
    res.status(500).json({ error: 'Failed to generate topic' });
  }
});



// ====================== /api/judge ======================
app.post("/api/judge", authenticateToken, async (req, res) => {
  const email = req.userEmail || req.body.email;
  const { topic, topicKey } = req.body;
  if (!email || !topic) return res.status(400).json({ error: 'Email and topic are required' });

  // Deduct 10 tokens for judging
  const tokenCheck = await deductTokens(email, 10, 'AI_JUDGE', 'LLM debate adjudication & scoring');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge your tokens to continue.', currentTokens: tokenCheck.currentTokens });
  }

  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const key = topicKey || topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    const entry = user.entries?.[key];
    if (!entry) return res.status(404).json({ error: 'Entry not found for this topic' });

    // DETERMINED USER'S ROLE
    let determinedUserRole = (entry.userrole || 'pm').toLowerCase();
    const propositionRoles = ['pm', 'dpm', 'gw'];
    const oppositionRoles = ['lo', 'dlo', 'ow'];
    const isProp = propositionRoles.includes(determinedUserRole);

    // Fetch user transcript
    const userTranscriptArray = isProp
      ? entry.proposition?.[determinedUserRole]?.transcript
      : entry.opposition?.[determinedUserRole]?.transcript;
    const userTranscript = (userTranscriptArray || []).join(" ");

    const systemPrompt = `
You are an expert AI debate judge. Evaluate the user's argument below on the topic "${topic}" (User Role: ${determinedUserRole.toUpperCase()}) across the following 10 criteria, scoring each from 0 to 10:
    
1. Logic
2. Clarity
3. Relevance
4. Persuasiveness
5. Depth
6. Evidence Usage
7. Emotional Appeal
8. Rebuttal Strength
9. Structure
10. Overall (average of the above 9)

Also provide:
- feedbackText: 2-3 sentences of direct constructive feedback.
- goodPart: 1-2 sentences highlighting exactly which part of the user's argument was particularly strong, logical, or persuasive (what was "good" / "google").
- reason: A 2-line explanation summarizing the overall debate outcome and how the user's performance influenced it.

Return ONLY a valid JSON object matching this structure (no markdown fences, no thinking tags, no extra text):
{
  "feedbackText": "...",
  "goodPart": "...",
  "reason": "...",
  "logic": number,
  "clarity": number,
  "relevance": number,
  "persuasiveness": number,
  "depth": number,
  "evidenceUsage": number,
  "emotionalAppeal": number,
  "rebuttalStrength": number,
  "structure": number,
  "overall": number
}`;

    let parsedUserScore = {
      feedbackText: "No speech delivered.",
      goodPart: "N/A",
      reason: "No argument was submitted to judge.",
      logic: 0, clarity: 0, relevance: 0, persuasiveness: 0, depth: 0, evidenceUsage: 0, emotionalAppeal: 0, rebuttalStrength: 0, structure: 0, overall: 0
    };

    if (userTranscript.trim()) {
      try {
        const input = `Debate Topic: ${topic}\nUser Role: ${determinedUserRole.toUpperCase()}\nUser Transcript: ${userTranscript}`;
        const response = await client.chat.completions({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: input }
          ]
        });

        let reply = response?.choices?.[0]?.message?.content || "";
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
        reply = reply.replace(/<think>[\s\S]*/gi, '');
        reply = reply.replace(/```json|```/g, '').trim();

        const jsonMatch = reply.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedUserScore = JSON.parse(jsonMatch[0]);
        }
      } catch (llmErr) {
        console.error("❌ LLM Evaluation failed, falling back to default grading:", llmErr);
      }
    }

    // Helper to format feedback object
    const makeFb = (obj) => ({
      feedbackText: obj.feedbackText || obj.feedbacktext || "Completed the debate role.",
      goodPart: obj.goodPart || obj.goodpart || "Constructive and clear speech.",
      logic: obj.logic ?? 0,
      clarity: obj.clarity ?? 0,
      relevance: obj.relevance ?? 0,
      persuasiveness: obj.persuasiveness ?? 0,
      depth: obj.depth ?? 0,
      evidenceUsage: obj.evidenceUsage ?? obj.evidenceusage ?? 0,
      evidenceusage: obj.evidenceUsage ?? obj.evidenceusage ?? 0,
      emotionalAppeal: obj.emotionalAppeal ?? obj.emotionalappeal ?? 0,
      emotionalappeal: obj.emotionalAppeal ?? obj.emotionalappeal ?? 0,
      rebuttalStrength: obj.rebuttalStrength ?? obj.rebuttalstrength ?? 0,
      rebuttalstrength: obj.rebuttalStrength ?? obj.rebuttalstrength ?? 0,
      structure: obj.structure ?? 0,
      overall: obj.overall ?? 0
    });

    const userFb = makeFb(parsedUserScore);

    // Determine debate level difficulty for mapping AIs
    const debateLevel = (entry.type || 'beginner').toLowerCase();

    // Helper to generate fixed AI scores based on level
    const getFixedAIScores = (levelStr, roleName) => {
      const level = (levelStr || 'beginner').toLowerCase();
      let baseScore = 6.0;
      if (level === 'intermediate') baseScore = 7.3;
      if (level === 'advanced') baseScore = 8.8;

      const criteria = [
        'logic', 'clarity', 'relevance', 'persuasiveness', 'depth',
        'evidenceusage', 'emotionalappeal', 'rebuttalstrength', 'structure'
      ];

      const scores = {};
      let total = 0;
      criteria.forEach(c => {
        // Subtle natural variance
        const variation = (Math.random() * 0.6) - 0.3;
        const score = Math.max(1, Math.min(10, parseFloat((baseScore + variation).toFixed(1))));
        scores[c] = score;
        total += score;
      });

      const overall = parseFloat((total / criteria.length).toFixed(1));

      return makeFb({
        feedbackText: `AI delivered a very structured argument perfectly matching the ${level} tier expectations for ${roleName.toUpperCase()}.`,
        goodPart: `Solid logical points with professional pacing.`,
        ...scores,
        overall
      });
    };

    entry.aifeedback = { proposition: {}, opposition: {}, winner: "", reason: "" };
    const fullResult = {};
    const maxRoles = entry.debateType === '1v1' ? 1 : 3;

    let propScore = 0;
    let oppScore = 0;

    for (let i = 0; i < 3; i++) {
      const proRole = propositionRoles[i];
      const oppRole = oppositionRoles[i];

      if (i >= maxRoles) {
        // Skip calling/mapping for empty roles in 1v1
        const zeroFb = makeFb({ feedbackText: "No speech delivered.", logic: 0, clarity: 0, relevance: 0, persuasiveness: 0, depth: 0, evidenceUsage: 0, emotionalAppeal: 0, rebuttalStrength: 0, structure: 0, overall: 0 });
        entry.aifeedback.proposition[proRole] = zeroFb;
        entry.aifeedback.opposition[oppRole] = zeroFb;
        fullResult[proRole] = zeroFb;
        fullResult[oppRole] = zeroFb;
        continue;
      }

      // Map Proposition Role
      let proFb;
      if (proRole === determinedUserRole) {
        proFb = userFb;
      } else {
        proFb = getFixedAIScores(debateLevel, proRole);
      }
      entry.aifeedback.proposition[proRole] = proFb;
      fullResult[proRole] = proFb;
      propScore += proFb.overall;

      // Map Opposition Role
      let oppFb;
      if (oppRole === determinedUserRole) {
        oppFb = userFb;
      } else {
        oppFb = getFixedAIScores(debateLevel, oppRole);
      }
      entry.aifeedback.opposition[oppRole] = oppFb;
      fullResult[oppRole] = oppFb;
      oppScore += oppFb.overall;
    }

    // Determine the Winner based on the scoring logic where the user's score decides the fate
    const winner = propScore > oppScore ? "Proposition" : "Opposition";

    // Check if the user won
    const userWon = (isProp && winner === "Proposition") || (!isProp && winner === "Opposition");

    // Construct premium reason text based on user's score vs benchmarks
    let reasonText = parsedUserScore.reason || "";
    if (!reasonText || reasonText.length < 5) {
      if (userWon) {
        reasonText = `The ${winner} team won the debate because of the exceptional performance by ${determinedUserRole.toUpperCase()} (User). The user's argument showed superb clarity and evidence usage, exceeding the ${debateLevel} standard and overshadowing the opposition's points.`;
      } else {
        reasonText = `The ${winner === "Proposition" ? "Proposition" : "Opposition"} team secured the victory. While the user (${determinedUserRole.toUpperCase()}) delivered a standard ${debateLevel} level performance, the opposing team had a more consistently high score across logical depth and rebuttal strength.`;
      }
    }

    entry.aifeedback.winner = winner;
    entry.aifeedback.reason = reasonText;
    user.entries[key] = entry;
    await putUser(user);

    res.json({ message: "All roles judged and result saved.", result: { ...fullResult, propositionScore: propScore, oppositionScore: oppScore, winner, reason: reasonText } });
  } catch (err) {
    console.error("❌ Judging failed:", err.message);
    res.status(500).json({ error: "Judging error" });
  }
});



app.get('/api/fetchJudgement', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // 1. Get the user
    const user = await getUser(email);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 2. Get all entries (they are in user.entries object)
    const entries = user.entries || {};

    if (Object.keys(entries).length === 0) {
      return res.status(404).json({ error: 'No entries found for this user' });
    }

    // 3. Find the latest entry by comparing createdAt
    let latestEntry = null;
    let latestDate = null;

    for (const [topicKey, entry] of Object.entries(entries)) {
      const created = new Date(entry.createdAt);
      if (!latestDate || created > latestDate) {
        latestDate = created;
        latestEntry = entry;
        latestEntry.topicKey = topicKey; // optional - if frontend needs the key
      }
    }

    if (!latestEntry) {
      return res.status(404).json({ error: 'No entry found' });
    }

    // 4. Build the response (same structure as before)
    const result = {
      winner: latestEntry.winner || null,
      reason: latestEntry.reason || null,
      topic: latestEntry.topic || null,
      proposition: latestEntry.aifeedback?.proposition || {},
      opposition: latestEntry.aifeedback?.opposition || {},
    };

    const userRole = latestEntry.userrole?.toLowerCase();
    const teamSide = latestEntry.stance?.toLowerCase(); // assuming stance = "proposition" or "opposition"

    if (teamSide && userRole && latestEntry.aifeedback?.[teamSide]?.[userRole]) {
      const userFeedback = latestEntry.aifeedback[teamSide][userRole];
      result.user = {
        ...userFeedback,
        role: userRole,
        team: teamSide,
      };
    }

    // Optional: log for debugging
    console.log("📦 Judgement Result Sent to Client:", JSON.stringify(result, null, 2));

    return res.json({ result });
  } catch (err) {
    console.error('Error fetching judgement:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// In your server file (e.g., server.js or routes.js)
// 🧠 Save Judgement Route
// ✅ Route: Save AI Judgement

app.post('/api/save-judgement', async (req, res) => {
  const { email, topicKey, judgeResult } = req.body;
  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.entries?.[topicKey]) return res.status(404).json({ error: "Topic entry not found" });

    const entry = user.entries[topicKey];
    const rolesMap = { pm: 'proposition', dpm: 'proposition', gw: 'proposition', lo: 'opposition', dlo: 'opposition', ow: 'opposition' };

    for (const [role, team] of Object.entries(rolesMap)) {
      const roleFeedback = judgeResult[role];
      if (!roleFeedback) continue;
      const feedback = {
        feedbackText: roleFeedback.feedbackText || 'yes',
        logic: roleFeedback.logic ?? 0,
        clarity: roleFeedback.clarity ?? 0,
        relevance: roleFeedback.relevance ?? 0,
        persuasiveness: roleFeedback.persuasiveness ?? 0,
        depth: roleFeedback.depth ?? 0,
        evidenceUsage: roleFeedback.evidenceUsage ?? 0,
        emotionalAppeal: roleFeedback.emotionalAppeal ?? 0,
        rebuttalStrength: roleFeedback.rebuttalStrength ?? 0,
        structure: roleFeedback.structure ?? 0,
        overall: roleFeedback.overall ?? 0,
      };
      if (entry[team]?.[role]) entry[team][role].aifeedback = feedback;
    }

    entry.winner = judgeResult.winner || '';
    entry.reason = judgeResult.reason || '';
    user.entries[topicKey] = entry;
    await putUser(user);
    res.status(200).json({ message: "Judgement saved successfully" });
  } catch (err) {
    console.error("❌ Error saving judgement:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ✅ Route: Generate AI Speech
app.post('/api/generateAISpeech', authenticateToken, async (req, res) => {
  const email = req.userEmail || req.body.email;
  const { role, team, topic, topicSlug, prep = "", previousSummaries = "" } = req.body;

  if (!email || !role || !team || (!topic && !topicSlug)) {
    return res.status(400).json({ error: 'Missing required fields: email, role, team, topic/topicSlug' });
  }

  // Deduct 5 tokens for generating AI Speech
  const tokenCheck = await deductTokens(email, 5, 'AI_SPEECH_GEN', 'Sarvam Text-to-Speech & Speech Generation');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge your tokens to continue.', currentTokens: tokenCheck.currentTokens });
  }

  try {
    let debateLevel = 'beginner';
    try {
      const user = await getUser(email);
      if (user) {
        const resolvedTopicSlug = topicSlug || topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
        let matchedSlug = resolvedTopicSlug;
        if (!user.entries?.[resolvedTopicSlug]) {
          const fallback = Object.entries(user.entries || {}).find(([, e]) => e.debateType === '3v3' && (e.topic || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_') === resolvedTopicSlug);
          if (fallback) {
            matchedSlug = fallback[0];
          } else {
            const latest3v3 = Object.entries(user.entries || {})
              .filter(([, e]) => e.debateType === '3v3')
              .sort(([, a], [, b]) => new Date(b.createdAt) - new Date(a.createdAt))[0];
            if (latest3v3) matchedSlug = latest3v3[0];
          }
        }
        const entry = user.entries?.[matchedSlug];
        if (entry) debateLevel = (entry.type || 'beginner').toLowerCase();
      }
    } catch (dbErr) {
      console.warn("Failed to fetch debate level from DB, falling back to beginner:", dbErr);
    }

    let vocabularyInstruction = "";
    if (debateLevel === 'beginner') {
      vocabularyInstruction = "Your vocabulary level is BEGINNER. Use extremely basic, simple English words and short, direct sentences. Avoid any complex, advanced, or fancy vocabulary.";
    } else if (debateLevel === 'advanced') {
      vocabularyInstruction = "Your vocabulary level is ADVANCED. Use sophisticated, rich, advanced English vocabulary, strong rhetorical phrasing, and complex grammatical structures.";
    } else {
      vocabularyInstruction = "Your vocabulary level is INTERMEDIATE. Use basic to medium, standard formal English suited for regular debaters.";
    }

    const systemPrompt = `You are a debater in an Asian Parliamentary debate. Speak directly as ${role.toUpperCase()} (${team === 'prop' ? 'Proposition' : 'Opposition'}). Start immediately in first person. No meta-commentary, no introductions, no <think> tags. Keep it under 150 words. ${vocabularyInstruction}`;

    // Trim prep to first 200 chars to reduce context size
    const trimmedPrep = (prep || '').substring(0, 200);

    // Only use last 2 speakers' summaries (most relevant for rebuttal), cap at 400 chars total
    const summaryLines = (previousSummaries || '').split('\n').filter(l => l.trim());
    const recentSummaries = summaryLines.slice(-6).join('\n').substring(0, 400);

    const userPrompt = `Topic: "${topic}"\nRole: ${role.toUpperCase()} (${team === 'prop' ? 'Proposition' : 'Opposition'})\nPrep: "${trimmedPrep}"\nRecent speeches to rebut:\n"${recentSummaries}"\n\nDeliver a persuasive 30-second speech:`;

    const response = await client.chat.completions({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: "sarvam-105b-conversations",
      max_tokens: 250,
      temperature: 0.5,
      reasoning_effort: null
    });

    let transcript = response.choices?.[0]?.message?.content?.trim() || "";

    // 1. Remove thinking tags and anything in between them (case-insensitive, dotall)
    transcript = transcript.replace(/<think>[\s\S]*?<\/think>/gi, '');
    transcript = transcript.replace(/<think>[\s\S]*/gi, ''); // in case of unclosed <think> tag

    // 2. Remove typical LLM introductory phrase lines
    const lines = transcript.split('\n');
    const filteredLines = lines.filter(line => {
      const cleanLine = line.trim().toLowerCase();
      if (cleanLine.startsWith('here is') ||
        cleanLine.startsWith('sure, here') ||
        cleanLine.startsWith('certainly!') ||
        cleanLine.startsWith('certainly, here') ||
        cleanLine.startsWith('okay, let me') ||
        cleanLine.startsWith('okay, i need') ||
        cleanLine.startsWith('as the ') && cleanLine.includes('prepare') ||
        cleanLine.startsWith('as the ') && cleanLine.includes('speech') ||
        cleanLine.startsWith('as a ') && cleanLine.includes('speech') ||
        cleanLine.startsWith('speech:') ||
        cleanLine.startsWith('**speech:**') ||
        cleanLine.startsWith('here\'s a ') ||
        cleanLine.startsWith('here is a ') ||
        cleanLine.includes('30-second speech') ||
        cleanLine.includes('30s speech') ||
        cleanLine.startsWith('okay, i will') ||
        cleanLine.startsWith('okay, here')) {
        return false; // exclude this intro line
      }
      return true;
    });
    transcript = filteredLines.join('\n').trim();

    // 3. Strip any surrounding quotation marks
    transcript = transcript.replace(/^["'`\s]+|["'`\s]+$/g, '').trim();

    if (!transcript || transcript.length < 10) {
      console.error("Empty or invalid transcript from Sarvam");
      return res.status(500).json({ error: 'Failed to generate valid speech from AI' });
    }

    // Save to DynamoDB (persistent!)
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const resolvedTopicSlug = topicSlug || topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    // Fallback: find entry by exact slug, or by matching topic text (handles slug drift)
    let matchedSlug = resolvedTopicSlug;
    if (!user.entries?.[resolvedTopicSlug]) {
      // Try to find a 3v3 entry with a matching topic
      const fallback = Object.entries(user.entries || {}).find(([, e]) => e.debateType === '3v3' && (e.topic || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_') === resolvedTopicSlug);
      if (fallback) {
        matchedSlug = fallback[0];
      } else {
        // Last resort: latest 3v3 entry
        const latest3v3 = Object.entries(user.entries || {})
          .filter(([, e]) => e.debateType === '3v3')
          .sort(([, a], [, b]) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        if (latest3v3) matchedSlug = latest3v3[0];
        else return res.status(404).json({ error: 'Debate entry not found' });
      }
    }

    const entry = user.entries[matchedSlug];
    const teamKey = team === 'prop' ? 'proposition' : 'opposition';

    if (!entry[teamKey]) entry[teamKey] = {};
    if (!entry[teamKey][role]) entry[teamKey][role] = { prep: "", transcript: [], summary: [], aifeedback: {} };

    // Append transcript (array)
    entry[teamKey][role].transcript.push(transcript);
    entry.updatedAt = new Date().toISOString();

    await putUser(user);

    console.log(`✅ AI speech saved for ${team}/${role}: ${transcript.substring(0, 50)}...`);

    res.status(200).json({ transcript });
  } catch (err) {
    console.error("❌ /api/generateAISpeech error:", err.message, err.stack);
    res.status(500).json({ error: 'Failed to generate AI speech' });
  }
});


// ✅ Route: Generate Summary
// ✅ Route: Generate Summary (DEBUG + FIXED version)
// ✅ Route: Generate Summary (FINAL FIXED VERSION)
// ✅ FIXED: /api/generateSummary (robust, matches your judge style, works with DynamoDB)
app.post('/api/generateSummary', authenticateToken, async (req, res) => {
  const email = req.userEmail || req.body.email;
  const { transcript, role, team, topic } = req.body;

  if (!transcript || transcript.trim().length < 5) {
    return res.status(400).json({ error: 'Transcript too short or missing' });
  }

  // Deduct 1 token for summary
  if (email) {
    const tokenCheck = await deductTokens(email, 1, 'AI_SUMMARY', 'LLM debate summary & transcript analysis');
    if (!tokenCheck.success) {
      return res.status(403).json({ error: 'Insufficient tokens. Please recharge your tokens to continue.', currentTokens: tokenCheck.currentTokens });
    }
  }

  try {
    const prompt = `You are a debate analyst.
Analyze the following ${role.toUpperCase()} (${team}) speech on "${topic || 'the debate'}" and produce exactly 3 very short summary sentences about their key highlights and point of view.

Rules:
- Do NOT include labels like "[CLAIM]", "[WEAKNESS]", "[REBUTTAL]", or "[COUNTER]". The opponent should figure those out themselves.
- Summarize what key points the speaker highlighted and what their point of view is.
- Keep each point to exactly 1 concise sentence (maximum 20 words).
- Put key highlights, terms, or phrases in **bold** (e.g. **economic impact**, **sustainability**).
- Return a valid JSON array of exactly 3 strings (sentences). No markdown formatting blocks, no thinking tags.

Example:
[
  "Argued that the policy will have a positive **economic impact** by creating local jobs.",
  "Highlighted **sustainability** as the primary goal for future generations.",
  "Believes that immediate action is needed to prevent **climate damage**."
]

Speech to analyze:
${transcript}`;

    const response = await client.chat.completions({
      messages: [{ role: 'user', content: prompt }],
      model: "sarvam-105b-conversations",
      max_tokens: 200,
      temperature: 0.3,
      reasoning_effort: null
    });
    let reply = response.choices?.[0]?.message?.content?.trim() || "[]";

    // 1. Remove thinking tags and anything in between them (case-insensitive, dotall)
    reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
    reply = reply.replace(/<think>[\s\S]*/gi, ''); // in case of unclosed <think> tag

    // 2. Remove json formatting backticks
    reply = reply.replace(/```json|```/g, '').trim();

    let summaryArray;
    try {
      summaryArray = JSON.parse(reply);
      if (!Array.isArray(summaryArray)) throw new Error();
    } catch {
      // Fallback if JSON fails: split by newlines, strip formatting bullets/quotes
      summaryArray = reply
        .split('\n')
        .map(line => line.replace(/^[-•*\s\d\.\"]+|[\"]+$/g, '').trim())
        .filter(line => line.length > 5);
    }

    // Clean up array elements: strip any remaining role labels (like "GW: ") or other speaker labels
    summaryArray = summaryArray.map(point => {
      let p = point.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '');

      // Strip any leading role prefixes (case-insensitive) e.g., "GW:", "DPM:", "PM:", etc.
      p = p.replace(/^[a-z0-9]+\s*:\s*/i, '');

      // Clean leading/trailing quotes or dashes
      return p.replace(/^["'`\s\-\•]+|["'`\s]+$/g, '').trim();
    }).filter(p => p.length > 3);

    // Ensure we have exactly 3 points
    if (summaryArray.length < 3) {
      const fallbacks = [
        `Presented arguments regarding the core issues of ${topic || 'the motion'}.`,
        `Supported the team's overall case stance and strategic position.`,
        `Rebutted opposition arguments to solidify the team's presentation.`
      ];
      while (summaryArray.length < 3) {
        summaryArray.push(fallbacks[summaryArray.length] || "Delivered key arguments supporting the team's stance.");
      }
    } else if (summaryArray.length > 3) {
      summaryArray = summaryArray.slice(0, 3);
    }

    res.json({ summary: summaryArray });

  } catch (err) {
    console.error('❌ Summary generation failed:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ✅ Optional: Get full memory state
app.get('/api/debateData', (req, res) => {
  res.json(debateStorage);
});

app.post("/api/userdata3v3", async (req, res) => {
  const { email, topicSlug, team, role, transcript, summary } = req.body;
  if (!email || !topicSlug || !team || !role || !transcript || !summary) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.entries = user.entries || {};
    if (!user.entries[topicSlug]) {
      user.entries[topicSlug] = {
        topic: topicSlug.replace(/_/g, ' '),
        type: "Beginner",
        debateType: "3v3",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }

    const entry = user.entries[topicSlug];
    const targetTeam = team.toLowerCase();
    const targetRole = role.toLowerCase();

    if (!entry[targetTeam]) entry[targetTeam] = {};
    if (!entry[targetTeam][targetRole]) {
      entry[targetTeam][targetRole] = { transcript: [], summary: [] };
    }

    entry[targetTeam][targetRole].transcript.push(transcript);
    entry[targetTeam][targetRole].summary.push(...(Array.isArray(summary) ? summary : [summary]));

    entry.updatedAt = new Date().toISOString();
    await putUser(user);

    res.status(200).json({ message: "3v3 entry updated", topicSlug });
  } catch (err) {
    console.error("❌ Error updating 3v3 entry:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ Save Role Transcript and Summary
// ✅ UPDATED: Save Role Transcript and Summary (DynamoDB safe version)
// ✅ UPDATED: Save Role Transcript and Summary (DynamoDB safe version)
app.post('/api/saveRoleTranscript', async (req, res) => {
  const { email, topicSlug, team, role, transcript, summary } = req.body;
  if (!email || !topicSlug || !team || !role || !transcript) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.entries = user.entries || {};
    if (!user.entries[topicSlug]) return res.status(404).json({ message: 'Topic not found' });

    const entry = user.entries[topicSlug];
    const roleLower = role.toLowerCase();   // ensures 'pm', 'lo', etc. (matches your DB)

    // 🔥 Auto-create if missing (this was the missing piece)
    if (!entry[team]) entry[team] = {};
    if (!entry[team][roleLower]) {
      entry[team][roleLower] = { transcript: [], summary: [] };
    }

    const roleBlock = entry[team][roleLower];

    if (!Array.isArray(roleBlock.transcript)) roleBlock.transcript = [];
    roleBlock.transcript.push(transcript);

    // summary can be array or string
    roleBlock.summary = Array.isArray(summary) ? summary : [summary || ''];

    entry.updatedAt = new Date().toISOString();
    await putUser(user);

    console.log(`✅ Saved for ${team}.${roleLower} (3v3)`);
    res.status(200).json({ message: 'Transcript and summary saved successfully' });
  } catch (err) {
    console.error('❌ Error saving transcript:', err);
    res.status(500).json({ message: 'Server error' });
  }
});




// Minimal schema setup for user
app.patch('/api/savePrep', async (req, res) => {
  const { email, topic, stance, debateType, userrole, userPrep, teammates } = req.body;
  const topicKey = topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.entries = user.entries || {};
    if (!user.entries[topicKey]) {
      user.entries[topicKey] = {
        topic,
        type: debateType,
        stance,
        userrole,
        proposition: {},
        opposition: {}
      };
    }

    const entry = user.entries[topicKey];
    const teamKey = stance === 'proposition' ? 'proposition' : 'opposition';

    if (!entry[teamKey]) entry[teamKey] = {};
    if (!entry[teamKey][userrole]) {
      entry[teamKey][userrole] = { prep: "", transcript: [], summary: [] };
    }
    entry[teamKey][userrole].prep = userPrep;

    teammates.forEach(({ role, prep }) => {
      if (!entry[teamKey][role]) {
        entry[teamKey][role] = { prep: "", transcript: [], summary: [] };
      }
      entry[teamKey][role].prep = prep;
    });

    entry.updatedAt = new Date().toISOString();
    await putUser(user);

    res.status(200).json({ message: "Prep saved successfully." });
  } catch (err) {
    console.error("❌ savePrep error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post('/api/userentry', async (req, res) => {
  const { email, topic } = req.body;
  if (!email || !topic) {
    return res.status(400).json({ error: "Missing email or topic" });
  }
  const topicKey = topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
  try {
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    const entry = user.entries?.[topicKey];
    if (!entry) return res.status(404).json({ error: "Topic entry not found" });

    return res.status(200).json({ entry });
  } catch (err) {
    console.error("❌ POST /api/userentry error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});



// Dummy teammate responses for role-based simulation
const teammateResponses = {
  teammate1: [
    "Let's begin with a solid foundation for our arguments.",
    "I'll ensure to handle logical fallacies and contradictions from the opposition.",
    "Don't forget to define key terms clearly in your opening."
  ],
  teammate2: [
    "I'll summarize our stance by tying back to the motion.",
    "I'll emphasize the long-term impacts of our argument.",
    "I'll highlight contradictions in the opposition's case during summary."
  ]
};

// Main endpoint for AI teammate simulation


// Route: Fetch user and debate entry
app.get('/api/getUserDebateData', async (req, res) => {
  const { email } = req.query;
  try {
    const user = await getUser(email);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});



const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_API_URL = 'https://api.sarvam.ai/v1/chat/completions';
app.post('/api/teama', authenticateToken, async (req, res) => {
  const { userInput, topic = 'General debate', role, stance = 'Neutral' } = req.body;

  if (!userInput || !role) {
    return res.status(400).json({ error: 'Missing userInput or role in /api/teammate' });
  }

  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_TEAMMATE', 'Case Prep teammate suggestion');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }

  try {
    let debateLevel = 'beginner';
    try {
      const user = await getUser(email);
      if (user) {
        const resolvedTopicSlug = topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
        let matchedSlug = resolvedTopicSlug;
        if (!user.entries?.[resolvedTopicSlug]) {
          const fallback = Object.entries(user.entries || {}).find(([, e]) => (e.topic || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_') === resolvedTopicSlug);
          if (fallback) matchedSlug = fallback[0];
        }
        const entry = user.entries?.[matchedSlug];
        if (entry) debateLevel = (entry.type || 'beginner').toLowerCase();
      }
    } catch (dbErr) {
      console.warn("Failed to fetch debate level from DB, falling back to beginner:", dbErr);
    }

    let vocabularyInstruction = "";
    if (debateLevel === 'beginner') {
      vocabularyInstruction = "You must use extremely basic, simple English words and short, direct sentences. Avoid any complex, advanced, or fancy vocabulary.";
    } else if (debateLevel === 'advanced') {
      vocabularyInstruction = "You must use sophisticated, rich, advanced English vocabulary, strong rhetorical phrasing, and complex grammatical structures.";
    } else {
      vocabularyInstruction = "You must use basic to medium, normal formal English suited for regular debaters.";
    }

    const prompt = `You are a AI debate teammate.
Debate Topic: ${topic}
Side: ${stance}
Role: ${role}
Teammate said: "${userInput}"
Suggest  ideas, present your point of view, answer in first person in short 40words, in informal. ${vocabularyInstruction}`;

    const fetchResponse = await fetch(process.env.SARVAM_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SARVAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sarvam-105b-conversations',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        reasoning_effort: null
      }),
    });

    if (!fetchResponse.ok) {
      const errText = await fetchResponse.text();
      throw new Error(`Sarvam API error: ${fetchResponse.status} ${fetchResponse.statusText} — ${errText}`);
    }

    const data = await fetchResponse.json();
    let result = data.choices?.[0]?.message?.content || 'No response from Sarvam AI';
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
    res.json({ result });
  } catch (err) {
    console.error('Sarvam API Error (/api/teammate):', err.message || err);
    res.status(500).json({ error: `Failed to get response from Sarvam AI: ${err.message}` });
  }
});




//caseprep


// /api/teamma — Strategic teammate suggestions

app.post('/api/search', authenticateToken, async (req, res) => {
  const { query } = req.body;
  if (!process.env.SARVAM_API_URL) {
    console.error('❌ SARVAM_API_URL is not set in .env');
  }

  if (!query) {
    return res.status(400).json({ error: 'Missing query in /api/search' });
  }

  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_RESEARCH', 'Case Prep evidence search');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }

  const prompt = `You are a research assistant for a debate preparation tool. Provide concise, relevant evidence, statistics, or case studies for the following query: "${query}"`;

  try {
    const fetchResponse = await fetch(process.env.SARVAM_API_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sarvam-105b-conversations',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        reasoning_effort: null
      }),
    });

    if (!fetchResponse.ok) {
      const errorText = await fetchResponse.text();
      throw new Error(`Sarvam API error: ${fetchResponse.status} ${fetchResponse.statusText} — ${errorText}`);
    }

    const data = await fetchResponse.json();
    let result = data.choices?.[0]?.message?.content || 'No results found.';
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
    res.json({ result });
  } catch (err) {
    console.error('Sarvam API Error (/api/search):', err.message || err);
    res.status(500).json({
      error: `Failed to get search results from Sarvam AI: ${err.message}`,
    });
  }
});

app.post('/api/teamma', authenticateToken, async (req, res) => {
  const { userInput, topic = 'General debate', role, stance = 'Neutral' } = req.body;

  if (!userInput || !role) {
    return res.status(400).json({ error: 'Missing userInput or role in /api/teammate' });
  }

  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_TEAMMATE', 'Case Prep strategic teammate suggestions');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }

  try {
    let debateLevel = 'beginner';
    try {
      const user = await getUser(email);
      if (user) {
        const resolvedTopicSlug = topic.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
        let matchedSlug = resolvedTopicSlug;
        if (!user.entries?.[resolvedTopicSlug]) {
          const fallback = Object.entries(user.entries || {}).find(([, e]) => (e.topic || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_') === resolvedTopicSlug);
          if (fallback) matchedSlug = fallback[0];
        }
        const entry = user.entries?.[matchedSlug];
        if (entry) debateLevel = (entry.type || 'beginner').toLowerCase();
      }
    } catch (dbErr) {
      console.warn("Failed to fetch debate level from DB, falling back to beginner:", dbErr);
    }

    let vocabularyInstruction = "";
    if (debateLevel === 'beginner') {
      vocabularyInstruction = "You must use extremely basic, simple English words and short, direct sentences. Avoid any complex, advanced, or fancy vocabulary.";
    } else if (debateLevel === 'advanced') {
      vocabularyInstruction = "You must use sophisticated, rich, advanced English vocabulary, strong rhetorical phrasing, and complex grammatical structures.";
    } else {
      vocabularyInstruction = "You must use basic to medium, normal formal English suited for regular debaters.";
    }

    const prompt = `You are a  AI debate teammate.
Debate Topic: ${topic}
Side: ${stance}
Role: ${role}
Teammate said: "${userInput}"
Suggest strategic ideas, questions to consider, or relevant points. start by hara krishna. ${vocabularyInstruction}`;

    const response = await client.chat.completions({
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: null
    });

    let result = response.choices?.[0]?.message?.content || 'No response from Sarvam AI';
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
    res.json({ result });
  } catch (err) {
    console.error('Sarvam API Error (/api/teammate):', err.message || err);
    res.status(500).json({ error: `Failed to get response from Sarvam AI` });
  }
});




// /api/summarize — Concise summarizer
app.post('/api/summarize', authenticateToken, async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Missing text in /api/summarize' });
  }

  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_SUMMARY', 'Case Prep text summarizer');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }

  const prompt = `Summarize this text in 1-2 short sentences, max 50 characters: "${text}"`;

  try {
    const response = await client.chat.completions({
      messages: [
        { role: 'system', content: 'You are an AI that summarizes text concisely.' },
        { role: 'user', content: prompt }
      ],
      reasoning_effort: null
    });

    let summary = response.choices?.[0]?.message?.content || 'No summary generated.';
    summary = summary.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
    res.json({ summary });
  } catch (err) {
    console.error('Sarvam API Error (/api/summarize):', err.message || err);
    res.status(500).json({ error: `Failed to summarize text` });
  }
});

app.post('/api/factcheck', authenticateToken, async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Missing text in /api/factcheck' });
  }

  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_FACTCHECK', 'Case Prep fact-checking assistance');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }

  const prompt = `You are a fact-checking AI. Verify the accuracy of the following text and provide a concise assessment of its factual correctness, including any corrections or clarifications if needed: "${text}"`;

  try {
    const response = await client.chat.completions({
      messages: [
        { role: 'system', content: 'You are an AI that verifies facts accurately.' },
        { role: 'user', content: prompt }
      ],
      reasoning_effort: null
    });

    let result = response.choices?.[0]?.message?.content || 'No fact-check results available.';
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '').trim();
    res.json({ result });
  } catch (err) {
    console.error('Sarvam API Error (/api/factcheck):', err.message || err);
    res.status(500).json({ error: `Failed to fact-check text` });
  }
});

app.post('/api/caseprepfetchdata', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      console.error('❌ Request missing email');
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await getUser(email);
    if (!user) {
      console.error(`❌ User not found for email: ${email}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const entries = user.entries || {};
    const entryKeys = Object.keys(entries);

    if (entryKeys.length === 0) {
      console.error(`❌ No entries found for user: ${email}`);
      return res.status(404).json({ error: 'No debate entries found for this user' });
    }

    // Find the latest entry by comparing createdAt
    let latestKey = entryKeys[0];
    let latestDate = new Date(entries[latestKey].createdAt || 0);

    for (const key of entryKeys) {
      const created = new Date(entries[key].createdAt || 0);
      if (created > latestDate) {
        latestDate = created;
        latestKey = key;
      }
    }

    const latestEntry = entries[latestKey];

    const topicSlug = latestKey || 'Untitled Debate Topic';
    const topic = latestEntry.topic || latestKey.replace(/_/g, ' ') || 'Untitled Debate Topic';
    const userRole = latestEntry.userrole || 'PM';
    const stance = latestEntry.stance || "dont know";
    const proposition = latestEntry.proposition || {};
    const opposition = latestEntry.opposition || {};

    // Debug logging (keep it for now)
    console.log('🟢 Proposition Summaries:', proposition);
    console.log('🔴 Opposition Summaries:', opposition);

    return res.json({
      topic,
      userRole,
      stance,
      proposition,
      opposition,
      topicSlug
    });
  } catch (err) {
    console.error(`❌ Internal error while fetching case prep data for ${req.body?.email}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});



// /api/caseprepsummariser endpoint (no authMiddleware)
app.post('/api/caseprepsummariser', authenticateToken, async (req, res) => {
  const { transcript, role, topic = 'General debate' } = req.body;

  if (!transcript || !role) {
    return res.status(400).json({ error: 'Missing transcript or role in /api/caseprepsummariser' });
  }

  const email = req.userEmail;
  const tokenCheck = await deductTokens(email, 1, 'AI_SUMMARY', 'Case Prep transcript summarization');
  if (!tokenCheck.success) {
    return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
  }

  const prompt = `You are an AI debate assistant summarizing a team member's transcript.
Debate Topic: ${topic}
Role: ${role}
Transcript: "${transcript}"
Summarize the transcript into exactly three key points to highlight in the main debate, each point being a concise sentence. Return the points as a JSON array, e.g., ["Point 1", "Point 2", "Point 3"].`;

  try {
    const fetchResponse = await fetch(process.env.SARVAM_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SARVAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sarvam-105b-conversations',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        reasoning_effort: null
      }),
    });

    if (!fetchResponse.ok) {
      const errText = await fetchResponse.text();
      throw new Error(`Sarvam API error: ${fetchResponse.status} ${fetchResponse.statusText} — ${errText}`);
    }

    const data = await fetchResponse.json();
    let highlights = data.choices?.[0]?.message?.content || '[]';

    highlights = highlights.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*/gi, '');
    highlights = highlights.replace(/```json|```/g, '').trim();

    try {
      highlights = JSON.parse(highlights);
      if (!Array.isArray(highlights) || highlights.length !== 3 || !highlights.every(h => typeof h === 'string')) {
        throw new Error('Highlights must be an array of exactly three strings');
      }
    } catch (err) {
      console.warn('Invalid JSON format, attempting to parse as text:', highlights);
      // Fallback: Split text into sentences and take first three
      const sentences = highlights.match(/[^.!?]+[.!?]+/g) || [highlights];
      highlights = sentences.slice(0, 3).map(s => s.trim());
      if (highlights.length < 3) {
        // Pad with placeholders if fewer than three sentences
        while (highlights.length < 3) {
          highlights.push('Summary point not available');
        }
      }
    }

    res.json({ highlights });
  } catch (err) {
    console.error('Sarvam API Error (/api/caseprepsummariser):', err.message || err);
    res.status(500).json({ error: `Failed to summarize transcript: ${err.message}` });
  }
});



// /api/saveSummary endpoint
// /api/saveSummary endpoint

// /api/saveSummary endpoint
// /api/saveSummary endpoint
app.post('/api/saveSummary', async (req, res) => {
  const { email, topic, topicSlug, team, role, highlights } = req.body;
  console.log('📝 /api/saveSummary: Received request:', { email, topic, topicSlug, team, role, highlights });

  if (!email || !topic || !topicSlug || !team || !role || !highlights) {
    console.error('❌ /api/saveSummary: Missing required fields');
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const validTeams = ['proposition', 'opposition'];
  const validRoles = team === 'proposition' ? ['pm', 'dpm', 'gw'] : ['lo', 'dlo', 'ow'];

  if (!validTeams.includes(team)) {
    return res.status(400).json({ message: `Invalid team: ${team}` });
  }
  if (!validRoles.includes(role)) {
    return res.status(400).json({ message: `Invalid role: ${role}` });
  }

  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.entries = user.entries || {};
    if (!user.entries[topicSlug]) return res.status(404).json({ message: 'Topic not found' });

    const entry = user.entries[topicSlug];
    if (!entry[team] || !entry[team][role]) {
      return res.status(400).json({ message: `Invalid team or role` });
    }

    const newPrep = Array.isArray(highlights) ? highlights.join(' ') : String(highlights || '');
    entry[team][role].prep = newPrep;
    entry.updatedAt = new Date().toISOString();

    await putUser(user);
    res.json({ message: 'Summary saved successfully' });
  } catch (err) {
    console.error('❌ /api/saveSummary error:', err);
    res.status(500).json({ message: 'Failed to save summary' });
  }
});

// /api/saveNotes endpoint
app.post('/api/saveNotes', async (req, res) => {
  const { email, topic, topicSlug, team, role, notes } = req.body;
  if (!email || !topic || !topicSlug || !team || !role || notes === undefined) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  try {
    let user = await getUser(email);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.entries = user.entries || {};
    if (!user.entries[topicSlug]) return res.status(404).json({ message: 'Topic not found' });

    const entry = user.entries[topicSlug];
    if (!entry[team] || !entry[team][role]) return res.status(400).json({ message: 'Invalid team or role' });

    entry[team][role].notes = notes;
    entry.updatedAt = new Date().toISOString();

    await putUser(user);
    res.json({ message: 'Notes saved successfully' });
  } catch (err) {
    console.error('Error saving notes:', err);
    res.status(500).json({ message: 'Failed to save notes' });
  }
});

app.get('/api/fetchNotes', async (req, res) => {
  try {
    const { email, topic, topicSlug, team, role } = req.query;
    if (!['pm', 'dpm', 'gw', 'lo', 'dlo', 'ow'].includes(role)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid role value' });
    }

    const user = await getUser(email);
    if (!user) return res.status(404).json({ status: 'fail', message: 'User not found' });

    const entry = user.entries?.[topicSlug];
    if (!entry) return res.status(404).json({ status: 'fail', message: 'Topic not found' });

    if (!entry[team]) return res.status(400).json({ status: 'fail', message: 'Invalid team' });
    if (!entry[team][role]) return res.status(400).json({ status: 'fail', message: 'Role not found in team' });

    const notes = entry[team][role].notes || '';
    res.status(200).json({ status: 'success', notes });
  } catch (err) {
    console.error('Error fetching notes:', err);
    res.status(500).json({ status: 'fail', message: 'Failed to fetch notes' });
  }
});

//ranking
// API Endpoint to Get Rankings
app.get('/api/rankings', authenticateToken, async (req, res) => {
  try {
    const allUsers = await scanAllUsers();

    const rankings = allUsers.map(user => {
      const entries = Object.values(user.entries || {});
      const totalDebates = entries.length;
      let wins = 0;
      for (const entry of entries) {
        const stance = entry.stance?.toLowerCase();
        const winner = entry.winner?.toLowerCase();
        if (stance && winner && stance === winner) wins++;
      }
      const winRate = totalDebates > 0 ? Math.round((wins / totalDebates) * 100) : 0;
      return {
        displayName: user.displayName || user.username || (user.email ? user.email.split('@')[0] : 'Anonymous'),
        email: user.email,
        wins,
        totalDebates,
        winRate
      };
    });

    // Sort by winRate desc, then wins desc
    rankings.sort((a, b) => b.winRate - a.winRate || b.wins - a.wins);

    const top10 = rankings.slice(0, 10);

    const currentUserEmail = req.userEmail;
    const currentUser = rankings.find(r => r.email === currentUserEmail);
    const currentUserRankInfo = currentUser ? { ...currentUser, rank: rankings.indexOf(currentUser) + 1 } : null;

    res.json({ top10, currentUser: currentUserRankInfo });
  } catch (error) {
    console.error('Error fetching rankings:', error);
    res.status(500).json({ error: 'Failed to fetch rankings' });
  }
});

// ====================== NEW: SAVE TRANSCRIPTS + SUMMARIES (DynamoDB) ======================
app.post('/api/save-transcripts', async (req, res) => {
  const { email, topicKey, userRole, userTranscripts, aiTranscripts, userSummary, aiSummary, userStance } = req.body;

  if (!email || !topicKey || !userRole) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    let user = await getUser(email);
    if (!user || !user.entries?.[topicKey]) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    const entry = user.entries[topicKey];
    const userTeam = userStance.toLowerCase();
    const aiTeam = userTeam === 'proposition' ? 'opposition' : 'proposition';

    // AI gets the matching opposite role (pm↔lo, dpm↔dlo, gw↔ow)
    const roleMap = { pm: 'lo', dpm: 'dlo', gw: 'ow', lo: 'pm', dlo: 'dpm', ow: 'gw' };
    const aiRole = roleMap[userRole.toLowerCase()] || 'lo';

    const userRoleLower = userRole.toLowerCase();

    // Ensure objects exist
    if (!entry[userTeam]) entry[userTeam] = {};
    if (!entry[userTeam][userRoleLower]) entry[userTeam][userRoleLower] = { transcript: [], summary: [] };
    if (!entry[aiTeam]) entry[aiTeam] = {};
    if (!entry[aiTeam][aiRole]) entry[aiTeam][aiRole] = { transcript: [], summary: [] };

    // Save full history
    entry[userTeam][userRoleLower].transcript = userTranscripts || [];
    entry[aiTeam][aiRole].transcript = aiTranscripts || [];

    // Save latest summaries (overwrites with current summary of recent turns)
    entry[userTeam][userRoleLower].summary = userSummary || [];
    entry[aiTeam][aiRole].summary = aiSummary || [];

    user.entries[topicKey] = entry;
    await putUser(user);

    res.json({ message: 'Transcripts and summaries saved successfully' });
  } catch (err) {
    console.error('❌ Save transcripts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mentor Endpoint
app.post('/api/mentor-chat', authenticateToken, async (req, res) => {
  const { question, chatHistory } = req.body;
  const email = req.userEmail;

  if (!question) {
    return res.status(400).json({ error: "Question is required." });
  }

  const parseJsonResponse = (text) => {
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '');
    }
    return JSON.parse(cleaned.trim());
  };

  try {
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: "User not found." });

    // Deduct tokens
    const tokenCheck = await deductTokens(email, 2, 'MENTOR_CHAT', 'Mentor session query');
    if (!tokenCheck.success) {
      return res.status(403).json({ error: 'Insufficient tokens. Please recharge.', currentTokens: tokenCheck.currentTokens });
    }

    const systemPrompt = `You are a world-class AI Communication and Debate Mentor. You are a warm, supportive, and friendly guide dedicated to the user's overall communication development, public speaking growth, and debate skills.
Your tone must be very informal, very friendly, very optimistic, and highly realistic. Speak to the user like a close, encouraging friend who is also an expert coach.
Keep your spoken responses highly spoken-friendly (conversational, concise, no markdown, no asterisks, as it will be spoken via Text-to-Speech).
By default, keep your responses short, sweet, and highly conversational. However, if the user explicitly asks for detailed analysis, extensive feedback, or complex debate/speech guidance, write a comprehensive, longer reply matching their request.

PERSISTENT MEMORY & NOTES:
You have a permanent memory system! If you learn something important about the user (e.g., their communication goals, specific things they struggle with, mistakes they want to avoid, or key milestones in their progress), you can decide to save a short, clear note/summary of it. 
Include it in the 'important_notes_to_save' array as a short bullet point (e.g., "Bhushan gets nervous when presenting the opposition side", "User wants to work on pacing and evidence usage"). This note will be saved in the database forever and presented to you in future calls so you always remember it!

DATA ACCESS ROUTING:
If the user asks for specific analysis on their past debates, their mistakes, how many debates they did today, their scores, or how to improve based on their history, you MUST request access to their debate data by returning this exact JSON structure:
{
  "request_data": true,
  "response": "Sure thing! Let me just pull up your debate records real quick to see how you've been doing...",
  "important_notes_to_save": []
}

If you don't need their data (e.g., general speaking tips, general rules, or standard conversational chat), answer them directly with this JSON structure:
{
  "request_data": false,
  "response": "Your friendly conversational spoken response here (no asterisks or markdown, pure spoken text)",
  "important_notes_to_save": ["Any new long-term summary note to save about this conversation"] // empty array if nothing new to save
}

You must ONLY return the raw JSON object. Do not include markdown code block syntax or backticks.
Do NOT include any <think> tags or internal reasoning outputs in your response. Return only the JSON object.`;

    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    if (Array.isArray(chatHistory) && chatHistory.length > 0) {
      // Exclude the very last turn if it's identical to the current question to avoid duplication
      const historyToInclude = chatHistory.slice(0, -1);

      // Sarvam AI validation rule: The first message after the system message MUST be a user message.
      // We skip any leading assistant messages in the payload (like the initial hello greeting).
      let hasUserMessageStarted = false;
      historyToInclude.forEach(msg => {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        if (role === 'user') {
          hasUserMessageStarted = true;
        }
        if (hasUserMessageStarted) {
          messages.push({
            role: role,
            content: msg.content
          });
        }
      });
    }

    messages.push({
      role: 'user',
      content: `The user asks: "${question}"`
    });

    const initialRes = await client.chat.completions({ messages });
    const rawText = initialRes.choices?.[0]?.message?.content || "{}";

    let data;
    try {
      data = parseJsonResponse(rawText);
    } catch (e) {
      console.warn("JSON parse failed, falling back to raw response formatting:", e);
      data = {
        request_data: false,
        response: rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/[*#]/g, '').trim(),
        important_notes_to_save: []
      };
    }

    if (data.request_data) {
      let historyContext = `User Dossier:\n`;
      historyContext += `- Display Name: ${user.displayName || 'Anonymous'}\n`;
      historyContext += `- Email: ${user.email}\n`;
      historyContext += `- Token Balance: ${user.tokens !== undefined ? user.tokens : 100}\n`;
      historyContext += `- Membership Plan: ${user.plan || 'standard'}\n\n`;

      historyContext += `User Debate History & Activity:\n`;
      const entriesObj = user.entries || {};
      const entries = Object.entries(entriesObj).map(([key, val]) => ({
        key,
        ...val
      }));

      // Sort by date descending
      entries.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

      const todayStr = new Date().toISOString().split('T')[0];
      let debatesToday = 0;
      entries.forEach(entry => {
        const entryDate = (entry.updatedAt || entry.createdAt || '').split('T')[0];
        if (entryDate === todayStr) {
          debatesToday++;
        }
      });

      historyContext += `- Debates completed today (${todayStr}): ${debatesToday}\n`;
      historyContext += `- Total debates completed all-time: ${entries.length}\n\n`;

      if (entries.length > 0) {
        historyContext += `Recent Debates (up to 5):\n`;
        entries.slice(0, 5).forEach((entry, idx) => {
          const topicName = (entry.topic || entry.key || '').replace(/_/g, ' ');
          const date = new Date(entry.updatedAt || entry.createdAt || '').toLocaleDateString();
          const stance = entry.stance || 'N/A';
          const winner = entry.winner || entry.aiJudgeFeedback?.winner || 'N/A';
          const userWon = (stance.toLowerCase() === winner.toLowerCase());

          let scoreInfo = '';
          if (entry.aiJudgeFeedback?.overallScores) {
            scoreInfo = `Scores: User ${entry.aiJudgeFeedback.overallScores.human || ''} - AI ${entry.aiJudgeFeedback.overallScores.ai || ''}`;
          } else if (entry.humanScore || entry.aiScore) {
            scoreInfo = `Scores: User ${entry.humanScore || ''} - AI ${entry.aiScore || ''}`;
          }

          historyContext += `${idx + 1}. [${date}] "${topicName}" (${stance} Stance)\n`;
          historyContext += `   Result: ${userWon ? 'User Won' : winner === 'N/A' ? 'Not Judged yet' : 'User Lost'} | ${scoreInfo}\n`;
          if (entry.aiJudgeFeedback?.verdict) {
            historyContext += `   Judge Verdict: "${entry.aiJudgeFeedback.verdict.slice(0, 150)}..."\n`;
          }

          // Include the user's own spoken transcript for this debate
          const userRole = entry.userrole?.toLowerCase();
          const userTeam = entry.stance?.toLowerCase();
          let userTranscript = null;
          if (userTeam && userRole) {
            const teamData = entry[userTeam] || {};
            const rawTranscript = teamData[userRole]?.transcript;
            if (Array.isArray(rawTranscript)) {
              userTranscript = rawTranscript.join(' ');
            } else if (typeof rawTranscript === 'string') {
              userTranscript = rawTranscript;
            }
          }
          if (userTranscript && userTranscript.trim().length > 20) {
            historyContext += `   Your Speech: "${userTranscript.slice(0, 300)}${userTranscript.length > 300 ? '...' : ''}"\n`;
          }
        });
      } else {
        historyContext += `User has not participated in any debates yet.\n`;
      }

      historyContext += `\nPronunciation Arena (Playground) Progress:\n`;
      const videoProgressObj = user.videoProgress || {};
      const videoEntries = Object.entries(videoProgressObj);
      historyContext += `- Total videos practiced: ${videoEntries.length}\n`;

      if (videoEntries.length > 0) {
        historyContext += `Practiced Videos list:\n`;
        videoEntries.slice(0, 5).forEach(([vidId, progress], idx) => {
          historyContext += `${idx + 1}. Video ID: ${vidId}\n`;
          historyContext += `   Scores: Pronunciation ${progress.pronunciationScore || 0}%, Understanding ${progress.understandingScore || 0}%\n`;
          if (progress.transcription) {
            historyContext += `   Transcription: "${progress.transcription.slice(0, 150)}${progress.transcription.length > 150 ? '...' : ''}"\n`;
          }
          if (progress.pronunciationFeedback) {
            historyContext += `   Feedback: "${progress.pronunciationFeedback.slice(0, 150)}..."\n`;
          }
        });
      } else {
        historyContext += `User has not completed any Pronunciation Arena exercises yet.\n`;
      }

      if (user.mentorNotes && user.mentorNotes.length > 0) {
        historyContext += `\nPreviously saved important mentor notes:\n- ` + user.mentorNotes.join('\n- ') + `\n`;
      }

      const secondPrompt = `
Here is the user's high-fidelity debate history, today's activity, pronunciation progress, and previously saved notes/insights:
${historyContext}

Now, answer their original question as a supportive, optimistic, and highly friendly mentor: "${question}"
Keep your tone very informal, friendly, and optimistic but completely realistic and honest.
Keep your response spoken-friendly, concise, and natural (no asterisks or markdown).
Remember: If the user asks for short feedback, keep it short and sweet. If they need extensive history review or detailed coaching analysis, make it longer and more comprehensive.

Return ONLY this JSON format:
{
  "response": "Your spoken response here (no asterisks or markdown, pure text to speak)",
  "important_notes_to_save": ["Any new long-term summary note to save about this conversation"] // empty array if nothing new to save
}
`;
      const secondRes = await client.chat.completions({
        messages: [{ role: 'user', content: secondPrompt }]
      });
      const secondRawText = secondRes.choices?.[0]?.message?.content || "{}";
      try {
        data = parseJsonResponse(secondRawText);
      } catch (e) {
        console.warn("JSON parse failed on second response:", e);
        data = {
          response: secondRawText.replace(/[*#]/g, '').trim(),
          important_notes_to_save: []
        };
      }
    }

    if (data.important_notes_to_save && data.important_notes_to_save.length > 0) {
      if (!user.mentorNotes) user.mentorNotes = [];
      user.mentorNotes.push(...data.important_notes_to_save);
      await putUser(user);
    }

    // Always include updated mentorNotes in response
    res.json({
      ...data,
      mentorNotes: user.mentorNotes || []
    });
  } catch (error) {
    console.error("Mentor Chat Error:", error);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

// Endpoint to fetch mentor notes on mount
app.get('/api/mentor-notes', authenticateToken, async (req, res) => {
  try {
    const user = await getUser(req.userEmail);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ mentorNotes: user.mentorNotes || [] });
  } catch (err) {
    console.error("Error fetching mentor notes:", err);
    res.status(500).json({ error: "Server error" });
  }
});

//test mobile google login

const { OAuth2Client } = require('google-auth-library');

// Initialize the Google Auth Client with your precise Web Client ID
const client2 = new OAuth2Client('912693025551-6t73l8sgi2invjh4rohpjhtmd3ml4n07.apps.googleusercontent.com');

// Middleware to parse incoming JSON request bodies (Ensure this is near the top of your server file)
// app.use(express.json());

app.post('/api/auth/android-google-login', async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({ 
                success: false, 
                message: 'Authentication failed: ID Token is required.' 
            });
        }

        // Securely verify the integrity of the token directly with Google's APIs
        const ticket = await client2.verifyIdToken({
            idToken: idToken,
            audience: '912693025551-6t73l8sgi2invjh4rohpjhtmd3ml4n07.apps.googleusercontent.com', // Must match your Web Client ID
        });

        // Extract the verified profile information payload
        const payload = ticket.getPayload();
        
        // This object contains all validated user details safely sent from Google
        const googleUser = {
            googleId: payload['sub'],       // Unique permanent user identification string
            email: payload['email'],         // User email address
            name: payload['name'],           // User full display name
            avatar: payload['picture']       // Profile picture URL link
        };

        console.log('✅ Google token successfully verified for:', googleUser.email);

        /* 👉 YOUR CUSTOM DATABASE LOGIC GOES HERE:
           
           const user = await User.findOne({ googleId: googleUser.googleId });
           if (!user) {
               // Create a new user account profile in your database
           }
           // Generate your custom JWT app login session token if needed
        */

        // Return a successful verification response to advance the frontend app layout
        return res.status(200).json({
            success: true,
            message: 'User authentication verified successfully.',
            user: googleUser
        });

    } catch (error) {
        console.error('❌ Google Token Verification Crash:', error.message);
        return res.status(401).json({
            success: false,
            message: 'Authentication rejected: Invalid or expired token profile signature.',
            error: error.message
        });
    }
});

// 🚀 Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} (DynamoDB - Users table only)`));




















