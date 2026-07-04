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
            content: `Tu es un expert en pronostics football, direct et tranché. Réponds UNIQUEMENT en JSON valide, sans texte autour, format exact:
{"score":"X-Y","confidence":NN,"reasoning":"une phrase courte en français expliquant le pronostic"}

Règles pour le pourcentage de confiance :
- Base-toi sur ce que tu sais réellement des deux équipes (niveau, réputation, championnat, historique connu). Si l'une est clairement plus forte ou plus reconnue que l'autre, ose descendre sous 30% ou monter au-dessus de 80%.
- Si les deux équipes te semblent vraiment équivalentes ou inconnues, un score autour de 50% est honnête — ne force pas un chiffre artificiellement "sûr" comme 60 ou 70 par défaut.
- Varie réellement tes réponses d'un match à l'autre, comme le ferait un vrai pronostiqueur qui a un avis tranché.
- N'utilise JAMAIS deux fois de suite la même valeur de confidence pour des matchs différents.

Règles pour le raisonnement :
- Mentionne un élément concret si tu le connais (forme récente, rivalité, niveau de championnat, join international vs club).
- Si tu ne sais rien des deux équipes, dis-le honnêtement dans le raisonnement plutôt que d'inventer un argument vague.`
          },
          {
            role: 'user',
            content: `Pronostic pour le match ${teamA} vs ${teamB}. Donne un score réaliste, un pourcentage de confiance sincère (n'importe où entre 5 et 95, selon ce que tu sais vraiment), et une raison courte et concrète.`
          }
        ],
        temperature: 0.9,
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
      reasoning: parsed.reasoning || 'Match équilibré, difficile à départager.'
    });
  } catch (e) {
    return res.status(500).json({ error: 'IA indisponible', details: e.message });
  }
};
