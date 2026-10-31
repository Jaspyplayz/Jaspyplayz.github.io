// Live League data for the Match History tab and the mastery slot in client/index.html.
// Games come from Turnpoint's public MCP endpoint, so they need no key here.
// Mastery comes from the Riot API and only loads when RIOT_API_KEY is set in the
// Vercel project's environment variables; without it the page keeps its built-in numbers.

const RIOT_ID = { gameName: "Jaspy", tagLine: "CA1" };
const REGION = "na";
const PLATFORM = "na1";
const ROUTING = "americas";
const TURNPOINT_MCP = "https://league-web-app.vercel.app/api/mcp";
const GAMES = 10;

let champCache = null; // { version, byName, byKey }, kept while the function instance is warm

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
  return res.json();
}

async function champions() {
  if (champCache) return champCache;
  const [version] = await getJson("https://ddragon.leagueoflegends.com/api/versions.json");
  const { data } = await getJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
  const byName = {}, byKey = {};
  for (const c of Object.values(data)) {
    const entry = { id: c.id, name: c.name, icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.id}.png` };
    byName[c.name.toLowerCase()] = entry;
    byName[c.id.toLowerCase()] = entry;
    byKey[c.key] = entry;
  }
  champCache = { version, byName, byKey };
  return champCache;
}

// Calls one Turnpoint MCP tool. The endpoint answers JSON-RPC as a single server-sent event.
async function turnpoint(name, args) {
  const res = await fetch(TURNPOINT_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`turnpoint ${res.status}`);
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : raw);
  if (msg.error || msg.result?.isError) throw new Error("turnpoint tool error");
  return JSON.parse(msg.result.content[0].text);
}

async function games(champ) {
  const data = await turnpoint("recent_games", {
    region: REGION,
    riotId: `${RIOT_ID.gameName}#${RIOT_ID.tagLine}`,
    count: GAMES,
  });
  return {
    record: data.record,
    games: data.games.map((g) => {
      const c = champ.byName[g.champion.toLowerCase()] || champ.byName[g.champion.replace(/[^a-z]/gi, "").toLowerCase()];
      return {
        matchId: g.matchId,
        playedAt: g.playedAt,
        queue: g.queue,
        result: g.result,
        champion: g.champion,
        icon: c ? c.icon : null,
        role: g.role,
        minutes: g.minutes,
        kda: g.kda,
        csPerMin: g.csPerMin,
        kp: g.killParticipationPercent,
      };
    }),
  };
}

async function mastery(champ) {
  const key = process.env.RIOT_API_KEY;
  if (!key) return null;
  const headers = { "X-Riot-Token": key };
  const account = await getJson(
    `https://${ROUTING}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(RIOT_ID.gameName)}/${encodeURIComponent(RIOT_ID.tagLine)}`,
    { headers }
  );
  const base = `https://${PLATFORM}.api.riotgames.com/lol/champion-mastery/v4`;
  const [score, top] = await Promise.all([
    getJson(`${base}/scores/by-puuid/${account.puuid}`, { headers }),
    getJson(`${base}/champion-masteries/by-puuid/${account.puuid}/top?count=3`, { headers }),
  ]);
  return {
    score,
    top: top.map((m) => {
      const c = champ.byKey[String(m.championId)];
      return { champion: c ? c.name : String(m.championId), icon: c ? c.icon : null, level: m.championLevel, points: m.championPoints };
    }),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  let champ;
  try {
    champ = await champions();
  } catch (err) {
    console.error("Data Dragon", err.message);
    champ = { byName: {}, byKey: {} };
  }
  const [g, m] = await Promise.allSettled([games(champ), mastery(champ)]);
  if (g.status === "rejected") console.error("games", g.reason?.message);
  if (m.status === "rejected") console.error("mastery", m.reason?.message);
  if (g.status === "rejected" && (m.status === "rejected" || !m.value)) {
    return res.status(502).json({ error: "upstream" });
  }
  // Shared caches keep this to about one upstream call every five minutes.
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
  return res.status(200).json({
    updatedAt: new Date().toISOString(),
    riotId: `${RIOT_ID.gameName}#${RIOT_ID.tagLine}`,
    record: g.status === "fulfilled" ? g.value.record : null,
    games: g.status === "fulfilled" ? g.value.games : [],
    mastery: m.status === "fulfilled" ? m.value : null,
  });
}
