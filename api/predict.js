// Cache mémoire simple (vit tant que la fonction reste "chaude" sur Vercel)
let standingsCache = {};
let cacheTimestamp = {};
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

const COMPETITIONS = ['FL1', 'PL', 'PD', 'BL1', 'SA', 'CL'];
// FL1 = Ligue 1, PL = Premier League, PD = Liga, BL1 = Bundesliga, SA = Serie A, CL = Champions League

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function getStandings(code) {
  const now = Date.now();
  if (standingsCache[code] && (now - cacheTimestamp[code] < CACHE_DURATION_MS)) {
    return standingsCache[code];
  }
  try {
    const res = await fetch(`https://api.football-data.org/v4/competitions/${code}/standings`, {
      headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    standingsCache[code] = data;
    cacheTimestamp[code] = now;
    return data;
  } catch (e) {
    return null;
  }
}

async function findTeamStats(teamName) {
  const target = normalize(teamName);
  for (const code of COMPETITIONS) {
    const data = await getStandings(code);
    if (!data || !data.standings) continue;
    const table = data.standings.find(s => s.type === 'TOTAL')?.table || [];
    const match = table.find(row => {
      const name = normalize(row.team.name);
      const shortName = normalize(row.team.shortName || '');
      return name.includes(target) || target.includes(name) || shortName.includes(target) || target.includes(shortName);
    });
    if (match) {
      return {
        competition: data.competition.name,
        position: match.position,
        points: match.points,
        played: match.playedGames,
        won: match.won,
        draw: match.draw,
        lost: match.lost,
        form: match.form || null
      };
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { teamA, teamB } = req.body;
  if (!teamA || !teamB) {
    return res.status(400).json({ error: 'Équipes manquantes' });
  }

  let statsA = null;
  let statsB = null;
  try {
    if (process.env.FOOTBALL_DATA_API_KEY) {
      [statsA, statsB] = await Promise.all([findTeamStats(teamA), findTeamStats(teamB)]);
    }
  } catch (e) {
    // En cas de souci avec l'API foot, on continue sans données réelles
  }

  function describeStats(name, stats) {
    if (!stats) return `${name} : aucune donnée de classement trouvée dans les 6 grands championnats suivis (peut-être une équipe nationale, un petit club, ou un autre championnat).`;
    return `${name} : ${stats.position}e place en ${stats.competition}, ${stats.points} points en ${stats.played} matchs (${stats.won}V ${stats.draw}N ${stats.lost}D)${stats.form ? `, forme récente : ${stats.form}` : ''}.`;
  }

  const realDataContext = `Données réelles actuelles :\n${describeStats(teamA, statsA)}\n${describeStats(teamB, statsB)}`;

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

Tu reçois parfois des données réelles de classement (position, points, forme récente). Quand elles sont disponibles pour les deux équipes, base ton pronostic dessus en priorité — c'est plus fiable que ta mémoire générale.
Quand les données réelles sont absentes pour une ou les deux équipes, base-toi sur ce que tu sais réellement (niveau, réputation, championnat, historique connu).

Règles pour le pourcentage de confiance :
- Si tu as des données réelles montrant un net écart de classement/points/forme, ose descendre sous 25% ou monter au-dessus de 80%.
- Si les deux équipes sont proches au classement ou inconnues, un score autour de 50% est honnête — ne force pas un chiffre artificiellement "sûr" comme 60 ou 70 par défaut.
- Varie réellement tes réponses d'un match à l'autre.
- N'utilise JAMAIS deux fois de suite la même valeur de confidence pour des matchs différents.

Règles pour le raisonnement :
- Si tu as des données réelles, cite un chiffre concret (ex: "3e vs 15e au classement", "forme WWDLW contre LLDWD").
- Si tu n'as aucune donnée réelle, dis-le honnêtement plutôt que d'inventer.`
          },
          {
            role: 'user',
            content: `${realDataContext}\n\nPronostic pour le match ${teamA} vs ${teamB}. Donne un score réaliste, un pourcentage de confiance sincère (entre 5 et 95), et une raison courte et concrète.`
          }
        ],
        temperature: 0.9,
        max_tokens: 220
      })
    });

    const data = await groqRes.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return res.status(200).json({
      score: parsed.score || '1-1',
      confidence: parsed.confidence || 50,
      reasoning: parsed.reasoning || 'Match équilibré, difficile à départager.',
      hasRealData: !!(statsA || statsB)
    });
  } catch (e) {
    return res.status(500).json({ error: 'IA indisponible', details: e.message });
  }
};
