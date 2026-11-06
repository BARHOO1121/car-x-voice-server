const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.post('/api/ask', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: "لم يتم تقديم أي أمر نصي" });
        }
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        res.json({ response: responseText });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "خطأ في السيرفر" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
