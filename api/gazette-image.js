// /api/gazette-image — generates a grayscale gnome / smithy newspaper engraving
// via OpenAI gpt-image-2, themed by the run's word list and headline.
//
// Request:  POST { words: string[], headline: string, lang: 'en'|'es',
//                  quality?: 'low'|'medium'|'high' }
// Response: 200 { image: "data:image/png;base64,..." }
//           4xx / 5xx { error: string }
//
// Cost note: gpt-image-2 costs ~$0.011 (low) to ~$0.13 (high) per call. We
// default to 'low' since the gazette image renders small. This endpoint is
// invoked ONLY when the player taps a button — never automatically — so the
// $/run stays predictable. The base64 is returned inline so the game doesn't
// need any storage layer; the client decides whether to keep it.

const OPENAI_URL = "https://api.openai.com/v1/images/generations";
const MODEL      = "gpt-image-2";

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
  const headers = corsHeaders(req.headers.origin || "");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY not configured on the server" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const words    = Array.isArray(body.words) ? body.words.filter(Boolean).slice(0, 30) : [];
  const headline = String(body.headline || "").slice(0, 100);
  const lang     = body.lang === "es" ? "es" : "en";
  const quality  = ["low", "medium", "high"].includes(body.quality) ? body.quality : "low";

  if (words.length < 1 || !headline) {
    return res.status(400).json({ error: "Need words[] and headline" });
  }

  // Prompt construction. We force a black-and-white woodcut/etching style so it
  // looks like an old newspaper engraving — matches the gazette's serif treatment.
  // gpt-image-2 renders text accurately but we explicitly tell it NO TEXT so it
  // doesn't try to caption the engraving with the headline (which would clash
  // with the actual rendered headline below it).
  const wordsList = words.slice(0, 8).join(", ");
  const prompt = lang === "es"
    ? `Grabado en blanco y negro estilo periódico antiguo, alto contraste, tinta negra sobre papel marfil envejecido, sin colores. Un gnomo herrero medieval relacionado con: "${headline}". Inspira la escena en estas palabras: ${wordsList}. Sin texto, sin letras, sin palabras, sin marcas de agua. Composición editorial cuadrada, lineas finas, textura de xilografía, dramático y caprichoso.`
    : `Black and white old-newspaper engraving, high contrast, black ink on aged ivory paper, no colors. A medieval gnome blacksmith scene illustrating: "${headline}". Pull visual cues from these forged words: ${wordsList}. Absolutely no text, no letters, no words, no watermarks. Square editorial composition, fine line work, woodcut texture, dramatic and whimsical.`;

  try {
    const aiRes = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        n: 1,
        size:    "1024x1024",
        quality,
      }),
    });

    if (!aiRes.ok) {
      const text = await aiRes.text().catch(() => "");
      // Surface useful diagnostics — most common failure is the org not being
      // verified for gpt-image-2 (returns 403 with a hint message).
      let msg = "";
      try { msg = JSON.parse(text)?.error?.message || ""; } catch { /* not JSON */ }
      return res.status(aiRes.status >= 400 && aiRes.status < 500 ? aiRes.status : 502).json({
        error: msg || `OpenAI ${aiRes.status}: ${text.slice(0, 200)}`,
      });
    }

    const data = await aiRes.json();
    const b64  = data?.data?.[0]?.b64_json;
    if (!b64) {
      return res.status(502).json({ error: "OpenAI returned no image data" });
    }

    return res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Image generation failed" });
  }
}
