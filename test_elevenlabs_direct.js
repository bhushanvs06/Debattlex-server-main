const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const VOICE_IDS = {
  Lily: 'pFZP5JQG7iQjIQuC4Bku',
  Gigi: 'jBpfuIE2acCO8z3wKNLl',
  Nicole: 'piTKgcLEGmPE4e6mEKli',
  Glinda: 'z9fAnlkpzviPz146aGWa'
};

async function runDirectTest() {
  console.log("Directly testing ElevenLabs API voices...");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  
  for (const [name, voiceId] of Object.entries(VOICE_IDS)) {
    const elevenlabsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    const headers = {
      'Accept': 'audio/mpeg',
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    };
    const data = {
      text: "Test",
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.5 }
    };

    try {
      const response = await axios.post(elevenlabsUrl, data, { headers, responseType: 'arraybuffer' });
      console.log(`✅ Success for ${name} (${voiceId})! Response status: ${response.status}`);
    } catch (error) {
      const status = error.response ? error.response.status : 'No response';
      const details = error.response ? JSON.stringify(error.response.data) : error.message;
      console.log(`❌ Failed for ${name} (${voiceId}) - Status: ${status} - Details: ${details}`);
    }
  }
}

runDirectTest();
