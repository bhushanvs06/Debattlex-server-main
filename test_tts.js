const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function runTests() {
  console.log("Starting TTS tests against local server...");
  console.log("ELEVENLABS_API_KEY exists in env:", !!process.env.ELEVENLABS_API_KEY);
  console.log("SARVAM_API_KEY exists in env:", !!process.env.SARVAM_API_KEY);
  
  // Test 1: Sarvam (Pro)
  try {
    console.log("\n--- Testing Sarvam (Pro) ---");
    const res = await axios.post('http://localhost:5000/api/tts', {
      text: "Hello from Sarvam test",
      voicePlan: "Pro",
      speaker: "manisha",
      role: "ai_1v1",
      email: "bhushanvs06@gmail.com" // we will try to use a dummy/typical email
    });
    console.log("Sarvam Success! Audio length:", res.data.audioBase64?.length);
  } catch (err) {
    console.error("Sarvam Error:", err.message);
    if (err.response) {
      console.error("Response status:", err.response.status);
      console.error("Response data:", err.response.data);
    }
  }

  // Test 2: ElevenLabs (Ultra)
  try {
    console.log("\n--- Testing ElevenLabs (Ultra) ---");
    const res = await axios.post('http://localhost:5000/api/tts', {
      text: "Hello from ElevenLabs test",
      voicePlan: "Ultra",
      speaker: "manisha",
      role: "pm",
      email: "bhushanvs06@gmail.com"
    });
    console.log("ElevenLabs Success! Audio length:", res.data.audioBase64?.length);
  } catch (err) {
    console.error("ElevenLabs Error:", err.message);
    if (err.response) {
      console.error("Response status:", err.response.status);
      console.error("Response data:", err.response.data);
    }
  }
}

runTests();
