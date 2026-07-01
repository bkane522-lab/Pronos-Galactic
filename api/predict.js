module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { teamA, teamB } = req.body;
  if (!teamA || !teamB) {
    return res.status(400).json({ error: 'Équipes manquantes' });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Tu es un expert en pronostics football. Réponds UNIQUEMENT en JSON valide, sans texte autour, avec ce format exact: {"score":"X-Y","confidence":NN,"reasoning":"une phrase courte en français expliquant le pronostic"}'
          },
          {
            role: 'user',
            content: `Pronostic pour le match ${teamA} vs ${teamB}. Donne un score réaliste, un pourcentage de confiance entre 40 et 90, et une raison courte.`
          }
        ],
        temperature: 0.7,
        max_tokens: 200
      })
    });

    const data = await groqRes.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return res.status(200).json({
      score: parsed.score || '1-1',
      confidence: parsed.confidence || 50,
      reasoning: parsed.reasoning || 'Match équilibré.'
    });
  } catch (e) {
    return res.status(500).json({ error: 'IA indisponible', details: e.message });
  }
};
