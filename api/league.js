// Live League data for the Match History tab in client/index.html.
// Games come from Turnpoint's public MCP endpoint, so no Riot key is needed here.

const RIOT_ID = { gameName: "Jaspy", tagLine: "CA1" };
const REGION = "na";
const TURNPOINT_MCP = "https://league-web-app.vercel.app/api/mcp";
const GAMES = 20;

let champCache = null; // { version, byName }, kept while the function instance is warm

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
  return res.json();
}

async function champions() {
  if (champCache) return champCache;
  const [version] = await getJson("https://ddragon.leagueoflegends.com/api/versions.json");
  const { data } = await getJson(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`);
  const byName = {};
  for (const c of Object.values(data)) {
    const entry = { id: c.id, name: c.name, role: (c.tags[0] || "").toLowerCase(), icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.id}.png` };
    byName[c.name.toLowerCase()] = entry;
    byName[c.id.toLowerCase()] = entry;
  }
  champCache = { version, byName };
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
        champClass: c ? c.role : null,
        role: g.role,
        minutes: g.minutes,
        kda: g.kda,
        csPerMin: g.csPerMin,
        kp: g.killParticipationPercent,
      };
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
    champ = { byName: {} };
  }
  let data;
  try {
    data = await games(champ);
  } catch (err) {
    console.error("games", err.message);
    return res.status(502).json({ error: "upstream" });
  }
  // Vercel's edge cache answers everyone for a week (Jasper's call), so Turnpoint sees about
  // one call a week per deployment. A new deployment starts with an empty cache.
  res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=86400");
  return res.status(200).json({
    updatedAt: new Date().toISOString(),
    riotId: `${RIOT_ID.gameName}#${RIOT_ID.tagLine}`,
    record: data.record,
    games: data.games,
  });
}
