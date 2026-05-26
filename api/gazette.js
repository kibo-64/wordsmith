// /api/gazette — generates a procedurally-flavored newspaper article from
// the player's run word list, via Claude Haiku 4.5.
//
// Request:  POST { words: string[], lang: 'en'|'es', level?: number,
//                  score?: number, longest?: string }
// Response: 200 { headline, dateline, body }   (all strings)
//           4xx / 5xx { error: string, fallback?: true }
//
// The client treats any non-200 as a signal to fall back to the procedural
// template, so we never block the gazette from rendering — AI is a bonus.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";

// Whitelist origins. playwordsmith.com is the production hostname; localhost
// is for `vercel dev` testing. * would also work but explicit is safer.
function corsHeaders(origin) {
  const allow = [
    "https://playwordsmith.com",
    "https://www.playwordsmith.com",
    "https://wordsmith.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
  ];
  const o = allow.includes(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default async function handler(req, res) {
  // CORS preflight
  const headers = corsHeaders(req.headers.origin || "");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on the server" });
  }

  let body = req.body;
  // Some Vercel runtimes leave req.body unparsed when Content-Type is missing
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const words   = Array.isArray(body.words) ? body.words.filter(Boolean).slice(0, 80) : [];
  const lang    = body.lang === "es" ? "es" : "en";
  const level   = Number(body.level)   || 1;
  const score   = Number(body.score)   || 0;
  const longest = String(body.longest || "");

  if (words.length < 3) {
    return res.status(400).json({ error: "Need at least 3 words to write a gazette" });
  }

  // Build the prompt. Haiku is fast + cheap so we lean into a richly-flavored
  // system message + a single user turn that hands over the word inventory.
  const system = lang === "es"
    ? `Eres el editor de "La Gaceta de los Gnomos", un periódico medieval de un pueblo de gnomos herreros. Escribes en español con un tono absurdo, gracioso y caprichoso — mezcla de noticias rurales y mitología de taller. Tu trabajo: a partir de una lista de palabras que un jugador forjó en una partida, escribir UNA noticia corta como si las palabras fueran personajes, lugares o eventos reales del mundo gnómico. Responde SOLO en JSON válido (sin markdown, sin explicación), con la forma exacta: {"headline":"...","dateline":"...","body":"..."}. El headline en MAYÚSCULAS, máximo 8 palabras. El dateline corto, 2-4 palabras, como "Distrito del Yunque" o "Detrás de la Fragua". El body es 2-3 oraciones, máximo 60 palabras, debe incorporar al menos 4 de las palabras de la lista (úsalas como nombres propios, lugares, o conceptos del mundo). Sé ingenioso, no genérico.`
    : `You are the editor of "The Gnomes' Gazette", a medieval newspaper from a village of gnome blacksmiths. You write in English with an absurd, witty, whimsical tone — equal parts village news and workshop folklore. Your job: given a list of words a player forged during a game run, write ONE short news story as if the words were real characters, places, or events from the gnome world. Respond ONLY in valid JSON (no markdown, no preamble), exactly: {"headline":"...","dateline":"...","body":"..."}. headline in ALL CAPS, max 8 words. dateline is short — 2-4 words like "Anvil District" or "Behind the Forge". body is 2-3 sentences, max 60 words, must work in at least 4 of the words from the list (use them as proper nouns, places, or world-concepts). Be inventive, not generic.`;

  const wordsList = words.join(", ");
  const userPrompt = lang === "es"
    ? `Palabras forjadas (en orden): ${wordsList}\n\nNivel: ${level}. Puntos: ${score}.${longest ? ` Palabra más larga: ${longest}.` : ""}\n\nEscribe el JSON ahora.`
    : `Forged words (in order): ${wordsList}\n\nLevel: ${level}. Score: ${score}.${longest ? ` Longest: ${longest}.` : ""}\n\nWrite the JSON now.`;

  try {
    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!aiRes.ok) {
      const text = await aiRes.text().catch(() => "");
      return res.status(502).json({ error: `Anthropic ${aiRes.status}: ${text.slice(0, 200)}`, fallback: true });
    }

    const data    = await aiRes.json();
    const content = data?.content?.[0]?.text || "";

    // Pull the JSON out of the response. Haiku is usually well-behaved with
    // JSON-only instructions, but be defensive — grab the first {...} block.
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({ error: "AI did not return JSON", fallback: true, raw: content.slice(0, 200) });
    }

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch (e) {
      return res.status(502).json({ error: "AI returned malformed JSON", fallback: true });
    }

    const headline = String(parsed.headline || "").slice(0, 100);
    const dateline = String(parsed.dateline || "").slice(0,  60);
    const bodyText = String(parsed.body     || "").slice(0, 600);
    if (!headline || !bodyText) {
      return res.status(502).json({ error: "AI response missing headline/body", fallback: true });
    }

    return res.status(200).json({ headline, dateline, body: bodyText });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "AI request failed", fallback: true });
  }
}
