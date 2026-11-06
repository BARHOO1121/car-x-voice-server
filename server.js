const express = require('express');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.get('/', (req, res) => {
  res.status(200).send('Car X Voice Server is Live!');
});

app.post(['/api/chat', '/chat', '/voice', '/'], async (req, res) => {
  try {
    const userMessage = req.body.message || req.body.prompt || "مرحباً";
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userMessage,
    });
    res.json({ reply: response.text });
  } catch (error) {
    console.error("Gemini API Error:", error);
    res.status(500).json({ error: "فشل الاتصال بخدمة الذكاء الاصطناعي" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
