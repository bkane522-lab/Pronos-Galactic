// Cache mémoire simple (vit tant que la fonction reste "chaude" sur Vercel)
let standingsCache = {};
let cacheTimestamp = {};
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

// Toutes les compétitions disponibles sur le plan gratuit football-data.org
const COMPETITIONS = ['FL1', 'PL', 'PD', 'BL1', 'SA', 'CL', 'DED', 'PPL', 'ELC', 'BSA', 'WC', 'EC'];
// FL1=Ligue 1, PL=Premier League, PD=Liga, BL1=Bundesliga, SA=Serie A, CL=Champions League,
// DED=Eredivisie, PPL=Liga Portugal, ELC=Championship (Angleterre 2e div), BSA=Brasileirão,
// WC=Coupe du Monde, EC=Euro (actifs seulement pendant les tournois)

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function apiFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function getStandings(code) {
  const now = Date.now();
  const key = `standings_${code}`;
  if (standingsCache[key] && (now - cacheTimestamp[key] < CACHE_DURATION_MS)) {
    return standingsCache[key];
  }
  const data = await apiFetch(`https://api.football-data.org/v4/competitions/${code}/standings`);
  if (data) {
    standingsCache[key] = data;
    cacheTimestamp[key] = now;
  }
  return data;
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
        teamId: match.team.id,
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

async function getHeadToHead(teamIdA, teamNameB, idB) {
  const now = Date.now();
  const key = `h2h_${teamIdA}`;
  let matchesData = standingsCache[key] && (now - cacheTimestamp[key] < CACHE_DURATION_MS)
    ? standingsCache[key]
    : null;

  if (!matchesData) {
    matchesData = await apiFetch(`https://api.football-data.org/v4/teams/${teamIdA}/matches?status=FINISHED&limit=50`);
    if (matchesData) {
      standingsCache[key] = matchesData;
      cacheTimestamp[key] = now;
    }
  }
  if (!matchesData || !matchesData.matches) return null;

  const targetB = normalize(teamNameB);
  const h2hMatches = matchesData.matches.filter(m => {
    const home = normalize(m.homeTeam.name);
    const away = normalize(m.awayTeam.name);
    const isB = idB ? (m.homeTeam.id === idB || m.awayTeam.id === idB) : (home.includes(targetB) || targetB.includes(home) || away.includes(targetB) || targetB.includes(away));
    return isB;
  }).slice(0, 5);

  if (h2hMatches.length === 0) return null;

  return h2hMatches.map(m => {
    const homeScore = m.score.fullTime.home;
    const awayScore = m.score.fullTime.away;
    return `${m.homeTeam.shortName || m.homeTeam.name} ${homeScore}-${awayScore} ${m.awayTeam.shortName || m.awayTeam.name}`;
  });
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
  let headToHead = null;

  try {
    if (process.env.FOOTBALL_DATA_API_KEY) {
      [statsA, statsB] = await Promise.all([findTeamStats(teamA), findTeamStats(teamB)]);
      if (statsA && statsA.teamId) {
        headToHead = await getHeadToHead(statsA.teamId, teamB, statsB ? statsB.teamId : null);
      }
    }
  } catch (e) {
    // En cas de souci avec l'API foot, on continue avec ce qu'on a
  }

  function describeStats(name, stats) {
    if (!stats) return `${name} : aucune donnée de classement trouvée (équipe nationale hors tournoi, petit club, ou championnat non couvert).`;
    return `${name} : ${stats.position}e place en ${stats.competition}, ${stats.points} points en ${stats.played} matchs (${stats.won}V ${stats.draw}N ${stats.lost}D)${stats.form ? `, forme récente : ${stats.form}` : ''}.`;
  }

  let realDataContext = `Données réelles actuelles :\n${describeStats(teamA, statsA)}\n${describeStats(teamB, statsB)}`;
  if (headToHead && headToHead.length > 0) {
    realDataContext += `\nConfrontations directes récentes : ${headToHead.join(' | ')}`;
  } else {
    realDataContext += `\nConfrontations directes récentes : aucune trouvée dans l'historique disponible.`;
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

Tu reçois parfois des données réelles : classement, points, forme récente, et confrontations directes passées. Quand elles sont disponibles, base ton pronostic dessus en priorité — c'est plus fiable que ta mémoire générale.
Quand les données réelles sont absentes, base-toi sur ce que tu sais réellement (niveau, réputation, championnat, historique connu) et dis-le honnêtement dans le raisonnement.

Règles pour le pourcentage de confiance :
- Si les données réelles montrent un net écart (classement, points, historique face-à-face dominé par une équipe), ose descendre sous 25% ou monter au-dessus de 80%.
- Si les équipes sont proches ou inconnues, reste autour de 50% — n'invente pas un chiffre "sûr" par défaut.
- Varie réellement tes réponses d'un match à l'autre, n'utilise jamais deux fois de suite la même valeur.

Règles pour le raisonnement :
- Si tu as des confrontations directes, cite un résultat précis (ex: "a gagné 3 des 5 dernières confrontations").
- Si tu as un classement, cite les positions exactes.
- Si tu n'as aucune donnée réelle, dis-le honnêtement plutôt que d'inventer un argument vague.`
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
      hasRealData: !!(statsA || statsB),
      hasHeadToHead: !!(headToHead && headToHead.length > 0)
    });
  } catch (e) {
    return res.status(500).json({ error: 'IA indisponible', details: e.message });
  }
};
